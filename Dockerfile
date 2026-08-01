# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口。
FROM nginx:1.27-alpine

RUN apk add --no-cache apache2-utils

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /usr/local/bin/infinite-canvas-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/infinite-canvas-entrypoint.sh \
    && chmod +x /usr/local/bin/infinite-canvas-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/infinite-canvas-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

EXPOSE 3000
