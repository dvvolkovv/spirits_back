# Базовый образ среды продукта.
#
# Внутри живут: чекаут продукта, раннер Linkeon и сам продукт под PM2.
# Раскладка намеренно повторяет проверенную на голой VM — раннер не знает,
# что он в контейнере, и работает тем же кодом, что уже обкатан.
#
# PID 1 — tini: без него зомби-процессы от claude и сборок накапливаются,
# потому что раннер их не жнёт.
# --- сборка раннера ---
# Собираем здесь, а не подкладываем готовый dist: иначе в образ уезжает то,
# что кто-то собрал у себя, и содержимое перестаёт следовать за исходниками.
FROM node:22-bookworm-slim AS runner-build
WORKDIR /build
COPY ./package.json ./package-lock.json ./tsconfig.json ./
RUN npm ci
COPY ./src ./src
RUN npx tsc -p tsconfig.json

# --- образ среды продукта ---
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl tini python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# PM2 управляет продуктом, claude — правит его код.
# Версии не пиннуются сознательно: образ пересобирается редко, а отставший
# claude ломает ходы тише, чем несовместимость после обновления.
RUN npm install -g pm2 @anthropic-ai/claude-code

WORKDIR /opt/runner
COPY ./package.json ./package-lock.json ./
RUN npm ci --omit=dev
COPY --from=runner-build /build/dist ./dist

# Чекаут продукта монтируется томом: код клиента не должен жить в образе,
# иначе откат к прошлому sha упрётся в слой, которого уже нет.
VOLUME ["/product"]
ENV CHECKOUT_PATH=/product \
    CLAUDE_BIN=/usr/local/bin/claude

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Агент работает не от root. Это требование самого CLI: обход подтверждений под
# root запрещён — а без обхода агент молча теряет право править файлы. Заодно
# правильно и по существу: код клиента исполняется без лишних привилегий.
#
# Пользователь node в образе уже есть с uid 1000; каталог продукта на хосте
# должен принадлежать тому же uid, иначе агент не запишет ни строчки.
RUN mkdir -p /home/node/.pm2 && chown -R node:node /home/node /opt/runner
USER node
ENV HOME=/home/node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
