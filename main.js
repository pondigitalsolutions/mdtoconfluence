import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfluenceClient } from 'confluence.js';
import * as dotenv from 'dotenv';
import { toHtml } from 'hast-util-to-html';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import texsvg from 'texsvg';
import { getInput } from '@actions/core';
import { create } from '@actions/glob';

async function run () {
  var config = {
    username: getInput('auth_username'),
    password: getInput('auth_password'),
    baseUrl: getInput('confluence_url'),
    space: getInput('confluence_space_key'),
    baseFolder: getInput('base_folder')
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
  const globber = await create(path.join(config.baseFolder, '**/*.md'))
  const files = await globber.glob()
  const mdFiles = files.map(file => {
    return file.replace(config.baseFolder, '')
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
  for (const file of mdFiles) {
    const markdown = await readFile(path.join(config.baseFolder, file), {
      encoding: 'utf-8'
    })
    console.log(markdown)
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
        const response = await fetch('https://mermaid.ink/img/' + encodeURIComponent(Buffer.from(node.value).toString('base64')))
        const buffer = await response.arrayBuffer()
        await writeFile(path.join(config.baseFolder, image), toBuffer(buffer))
        assets.push(image)
        return {
          type: 'image',
          url: image,
        }
      }
      if (node.type === 'math' || node.type === 'inlineMath') {
        const svg = await texsvg(node.value);
        const image = file.replace('.md', '-' + assets.length + '.svg')
        await writeFile(path.join(config.baseFolder, image), svg)
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

    const content = await confluence.content.getContent({
      spaceKey: config.space,
      title,
    })

    let id = null;
    let version = 1;
    const parent = file.replace('/index', '').split('/').reverse()?.[1]
    let parentId = configFile?.parent_id
    console.log(parent)
    if (parent) {
      const parentContent = await confluence.content.getContent({
        spaceKey: config.space,
        title: parent,
      })
      parentId = parentContent.results[0].id
    }
    if (content.results.length === 0) {
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
          file: await readFile(path.join(config.baseFolder, asset)),
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
}
run()