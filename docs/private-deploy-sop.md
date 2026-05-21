# gpt-image-playground 私人定制协作与部署 SOP

> 目的：私人化改动必须先进入 `Micah-Zheng/gpt_image_playground` 的私人化分支，再由服务器拉取该分支构建部署。禁止把容器内手改当作正式交付。

## 0. 当前协作关系

- 私人定制仓库：`https://github.com/Micah-Zheng/gpt_image_playground`
- 私人部署基准分支：`private/async-image-proxy`
- 上游开源仓库：`https://github.com/CookSleep/gpt_image_playground`
- 推荐本地目录：`/Users/micahzheng/projects/gpt_image_playground`
- 生产容器名：`gpt-image-playground`

约定：

- `main` 尽量只用于跟随上游，不直接做私人化修改。
- `private/async-image-proxy` 是当前生产部署基准分支。
- 协作者从 `private/async-image-proxy` 新建工作分支，改完后 PR 回 `private/async-image-proxy`。
- 服务器只从 `Micah-Zheng/gpt_image_playground:private/async-image-proxy` 部署，不从临时工作分支部署。

## 1. 铁律

1. 不要直接修改容器里的代码。
2. 不要在服务器构建目录里手改后直接重启，除非是临时救火；救火后必须补回 Git。
3. 所有改动必须先进 Git：本地改代码、提交、推工作分支、PR 合并到部署基准分支。
4. 不要把私人化分支推到上游 `CookSleep/gpt_image_playground`。
5. 不要提交 API Key、Token、私钥、`.env`、服务器地址等敏感信息。

## 2. 推荐远端命名

```bash
cd /Users/micahzheng/projects/gpt_image_playground
git remote -v
```

正常应类似：

```text
origin    https://github.com/Micah-Zheng/gpt_image_playground.git
upstream  https://github.com/CookSleep/gpt_image_playground.git
```

如果缺少上游远端：

```bash
git remote add upstream https://github.com/CookSleep/gpt_image_playground.git
```

开启冲突复用：

```bash
git config rerere.enabled true
```

## 3. 分支模型

```text
main                       # 跟踪上游，不放私人定制
private/async-image-proxy  # 私人定制部署基准分支，只通过 PR 或明确维护操作更新
teammate/xxx               # 协作者工作分支，从 private/async-image-proxy 新建
fix/xxx                    # 单次修复分支，从 private/async-image-proxy 新建
```

## 4. 开始改代码前

```bash
cd /Users/micahzheng/projects/gpt_image_playground

git fetch origin
git switch private/async-image-proxy
git pull --ff-only origin private/async-image-proxy

git switch -c teammate/short-description
git status --short --branch
```

确认当前分支是工作分支，而不是 `main` 或 `private/async-image-proxy`。

## 5. 本地修改和验证

修改后先看 diff：

```bash
git diff
```

推荐验证：

```bash
npm ci
npm run build
```

如果只改文档，至少运行：

```bash
git diff --check
```

如果改了 Docker 部署链路，额外检查：

```bash
docker build -f deploy/Dockerfile -t gpt-image-playground:local-check .
```

## 6. 提交工作分支

```bash
git status --short
git add <你改过的文件>
git commit -m "简短说明这次改动"
git push -u origin teammate/short-description
```

然后在 GitHub 上开 PR：

```text
base:    Micah-Zheng/gpt_image_playground:private/async-image-proxy
compare: Micah-Zheng/gpt_image_playground:teammate/short-description
```

不要执行：

```bash
git push upstream private/async-image-proxy
git push upstream main
```

## 7. PR 合并规则

合并前确认：

- PR 目标分支是 `private/async-image-proxy`。
- 没有冲突。
- 改动范围符合本次任务，没有混入无关文件。
- 没有密钥、token、私钥、`.env` 等敏感信息。
- 涉及代码时，`npm run build` 通过。

## 8. 服务器部署原则

生产部署只从私人仓库的部署基准分支拉代码：

```text
仓库：https://github.com/Micah-Zheng/gpt_image_playground.git
分支：private/async-image-proxy
容器：gpt-image-playground
镜像命名：gpt-image-playground:async-YYYYMMDDHHMMSS
```

服务器部署时，不从 `teammate/*`、`fix/*` 等工作分支部署。

## 9. 服务器部署命令

在服务器执行：

```bash
set -euo pipefail

BUILD_DIR="$HOME/gpt_image_playground"
BRANCH="private/async-image-proxy"
REPO="https://github.com/Micah-Zheng/gpt_image_playground.git"
IMAGE="gpt-image-playground:async-$(date +%Y%m%d%H%M%S)"

if [ ! -d "$BUILD_DIR/.git" ]; then
  rm -rf "$BUILD_DIR"
  git clone --branch "$BRANCH" --single-branch "$REPO" "$BUILD_DIR"
else
  git -C "$BUILD_DIR" remote set-url origin "$REPO"
  git -C "$BUILD_DIR" fetch origin "$BRANCH"
  git -C "$BUILD_DIR" switch "$BRANCH" >/dev/null 2>&1 || git -C "$BUILD_DIR" checkout -B "$BRANCH"
  git -C "$BUILD_DIR" reset --hard FETCH_HEAD
fi

cd "$BUILD_DIR"
echo "deploy_commit=$(git rev-parse HEAD)"
docker build -f deploy/Dockerfile -t "$IMAGE" .
echo "$IMAGE" > "$HOME/.gpt-image-playground-last-image"
```

然后替换生产容器：

```bash
set -euo pipefail

IMAGE="$(cat "$HOME/.gpt-image-playground-last-image")"

docker rm -f gpt-image-playground >/dev/null 2>&1 || true
docker run -d \
  --name gpt-image-playground \
  --restart unless-stopped \
  --network new-api_default \
  -p 127.0.0.1:3080:80 \
  -e DEFAULT_API_URL=https://api.tcp.red/v1 \
  -e ENABLE_ASYNC_IMAGE_PROXY=true \
  -e ASYNC_IMAGE_DIRECT_API_URL=http://new-api:3000/v1 \
  -e ASYNC_IMAGE_UPSTREAM_TIMEOUT_SECONDS=900 \
  -e ASYNC_IMAGE_JOB_TTL_SECONDS=1800 \
  -e ASYNC_IMAGE_MAX_REQUEST_MB=40 \
  "$IMAGE"
```

部署后检查：

```bash
docker ps --filter name=gpt-image-playground --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
curl -fsSI http://127.0.0.1:3080/image-playground/ | sed -n '1,12p'
docker logs --tail 80 gpt-image-playground
```

## 10. 同步上游更新

```bash
cd /Users/micahzheng/projects/gpt_image_playground

git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main

git switch private/async-image-proxy
git merge main
```

如果有冲突：

```bash
git diff --name-only --diff-filter=U
grep -R -n '<<<<<<<\|=======\|>>>>>>>' src deploy public docs || true
npm run build
git commit --no-edit
git push origin private/async-image-proxy
```

处理原则：

- 保留上游新增功能和结构。
- 保留私人化部署链路：异步图片代理、Node 静态服务、旧 service worker 清理、生产容器运行参数。
- 如果上游已经实现了等价能力，优先收敛到上游实现，减少私人补丁面积。

## 11. 回滚

优先回滚到上一个已知可用镜像：

```bash
docker images 'gpt-image-playground:async-*' --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | head
```

确认目标镜像后，用第 9 节的 `docker run` 命令重新启动该镜像。

如果需要 Git 回滚，在本地新建 revert commit，再按正常 PR/部署流程走，不要在服务器手改源码。
