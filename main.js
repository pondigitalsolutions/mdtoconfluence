import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { ConfluenceClient } from 'confluence.js';
import * as dotenv from 'dotenv';
import FastGlob from 'fast-glob';
import { toHtml } from 'hast-util-to-html';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import texsvg from 'texsvg';
import { getInput } from '@actions/core';

dotenv.config()
var config = {
  username: getInput('auth_username') || process.env.auth_username,
  password: getInput('auth_api_token') || process.env.auth_api_token,
  baseUrl: getInput('confluence_url') || process.env.confluence_url,
  space: getInput('confluence_space_key') || process.env.confluence_space_key,
  baseFolder: getInput('base_folder') ? path.join('/github/workspace', getInput('base_folder')) : process.env.base_folder
};
var confluence = new ConfluenceClient({
  host: config.baseUrl,
  newErrorHandling: true,
  authentication: {
    basic: {
      email: config.username,
      apiToken: config.password
    }
  }
});
const files = await FastGlob( '**/*.md', {
  cwd: config.baseFolder
})
let configFile = {}
try {
  configFile = JSON.parse(await readFile(path.join(config.baseFolder, 'settings.json')))
} catch (e) {
  console.log('No config file found')
}

const asyncMap = async (array, fn) => {
  const results = []
  for (const item of array) {
    results.push(await fn(item))
  }
  return results
}

const toBuffer = (arrayBuffer) => {
  const buffer = Buffer.alloc(arrayBuffer.byteLength);
  const view = new Uint8Array(arrayBuffer);
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}
for (const file of files) {
  const markdown = await readFile(path.join(config.baseFolder, file), {
    encoding: 'utf-8'
  })
  const mdast = fromMarkdown(markdown, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })


  const worker = (file, assets) => async (node) => {
    if (node.children) {
      node.children = await asyncMap(node.children, worker(file, assets))
    }
    if (node.type === 'image') {
      assets.push(node.url)
      return {
        type: 'image',
        url: node.url,
      }
    }
    if (node.type === 'code' && node.lang === 'mermaid') {
      const image = file.replace('.md', '-' + assets.length + '.png')
      const response = await axios.request({
        url: 'https://mermaid.ink/img/' + encodeURIComponent(Buffer.from(node.value).toString('base64')),
        method: 'GET',
        responseType: 'arraybuffer'
      })
      const buffer = await response.data
      await writeFile(path.join('/.cache/md', image), toBuffer(buffer))
      assets.push(image)
      return {
        type: 'image',
        url: image,
      }
    }
    if (node.type === 'math' || node.type === 'inlineMath') {
      const svg = await texsvg(node.value);
      const image = file.replace('.md', '-' + assets.length + '.svg')
      await writeFile(path.join('/.cache/md', image), svg)
      assets.push(image)
      return {
        type: 'image',
        url: image,
      }
    }
    return node
  }

  const assets = []

  mdast.children = await asyncMap(mdast.children, worker(file, assets))
  const hast = toHast(mdast)
  let html = toHtml(hast, {
    closeSelfClosing: true,
  })

  html = html.replace(/<img src="(.*?)" \/>/g, '<ac:image><ri:attachment ri:filename="$1" /></ac:image>')

  const title = file.replace('/index.md', '').replace('.md', '').split('/').reverse()[0]
  console.log(config)

  const content = await confluence.content.getContent({
    spaceKey: config.space,
    title,
  })

  let id = null;
  let version = 1;
  const parent = file.replace('/index', '').split('/').reverse()?.[1]
  let parentId = configFile?.parent_id
  if (parent) {
    const parentContent = await confluence.content.getContent({
      spaceKey: config.space,
      title: parent,
    })
    console.log(`Parent: ${parent}`)
    parentId = parentContent.results[0].id
  }
  if (content.results.length === 0) {
    console.log(`Create content: ${file}`)
    const newPage = await new Promise(r => confluence.content.createContent({
      space: {
        key: config.space
      },
      title,
      type: 'page',
      body: {
        storage: {
          value: html,
          representation: 'storage'
        }
      },
      ancestors: parentId ? [{ id: parentId }] : [],
      version: {
        number: version,
      },
    }, r))
    id = newPage.id
  } else {
    id = content.results[0].id
    console.log(`Update content: ${file}`)
    const getContentById = await confluence.content.getContentById({
      id
    })
    version = getContentById.version.number + 1
    await confluence.content.updateContent({
      space: {
        key: config.space
      },
      type: 'page',
      id: content.results[0].id,
      version: {
        number: version
      },
      title,
      body: {
        storage: {
          representation: 'storage',
          value: html
        }
      },
      ancestors: parentId ? [{ id: parentId }] : [],
    })
  }
  if (assets.length) {

    await confluence.contentAttachments.createOrUpdateAttachments({
      space: {
        key: config.space
      },
      attachments: await asyncMap(assets, async (asset) => ({
        file: await readFile(path.join('/.cache/md', asset)),
        filename: asset,
        comment: 'Uploaded by exact-gateway',
        minorEdit: true,
      })),
      id,
      version: {
        number: version,
      },
    })
  }
}