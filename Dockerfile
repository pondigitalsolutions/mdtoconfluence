FROM node:19-alpine3.17

WORKDIR /

RUN apk add --no-cache jq bash git

COPY . .

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]