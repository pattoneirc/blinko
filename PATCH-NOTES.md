# Blinko 移动端 / 列表性能补丁说明

基线：`blinkospace/blinko` **1.8.9**（tag `1.8.9`，commit `80e1c4f`）
分支：`patch/1.8.9-mobile-perf`

只改前端（`app/src`），后端、数据库、API 一律没动。

## 改了什么

| 文件 | 目的 |
| --- | --- |
| `app/src/components/Common/LoadingAndEmpty.tsx` | 三点加载图标只在 `isLoading` 时挂载；首页固定预留 30px 槽位。原来用 `h-0` 隐藏，SMIL `animate` 仍在跑（空闲 180 次布局/秒、主线程 27.8%），且 `h-0`↔`h-[30px]` 切换会把列表顶下 30px |
| `app/src/store/standard/PromiseState.ts` | `callNextPage()` 增加 `isLoadAll` 守卫，到底后不再重复请求 |
| `app/src/store/blinkoStore.tsx` | `onBottom()` 的 `path === 'all'` 分支由 `resetAndCall()` 改为 `callNextPage()`，触底是翻页而不是重拉第 1 页 |
| `app/src/components/Common/MarkdownRender/ImageWrapper.tsx` | `loading="lazy"` + `decoding="async"`；内部文件加 `?thumbnail=true`（500px）。保留 1.8.9 新增的 `getBlinkoFileUrl(src, { token })` |
| `app/src/components/Common/Editor/hooks/useEditor.ts` | 弹窗内的 Vditor 显式给 `minHeight: 220` 和 `height: 50vh`。默认 `height:auto` 时，弹窗在开启动画中高度为 0，Vditor 会把内容区算成 0（表现为白板、点不进去、键盘不弹） |
| `app/src/components/BlinkoEditor/index.tsx` | 移动端看门狗：3 秒内拿不到"可见且高度 > 30px 的 contenteditable"就回退纯 `textarea`（注意 Vditor 同时渲染 wysiwyg/ir/sv 三个面板，必须用 `offsetParent !== null` 过滤） |
| `app/src/components/Layout/index.tsx` | 手机端全屏右滑打开标签侧栏，侧栏打开时左滑收起；`cardSwipeOpenRef` 让卡片操作面板打开时全局右滑让位 |
| `app/src/components/BlinkoCard/SwipeableCard.tsx` | `isOpen` 变化时广播 `blinko:card-swipe` 事件，供全局手势仲裁 |
| `app/src/components/BlinkoCard/index.tsx` | 恢复卡片左滑（`SwipeableCard` 去掉 `disabled`） |
| `app/src/components/Common/TagListPanel.tsx`、`app/src/components/Layout/Sidebar.tsx` | 点标签后调用 `onItemClick()` 收起手机抽屉 |
| `app/src/pages/index.tsx` | 首页列表底部固定槽位 |
| `app/src/styles/globals.css` | 编辑区最小高度兜底 |

## 构建

### Web

```bash
bun install
cd app && bun run build:web          # 产物在 dist/public
```

### Android APK

前置：

- Rust + `rustup target add aarch64-linux-android`
- JDK 17、Android SDK（platform 35）、NDK 28
- **`bun.exe` 必须在 PATH 里**：Tauri 的 Gradle 任务用 `Exec("bun")` 启动，npm 装的 `bun.cmd` 不算，会因为 `command 'bun.exe'` 找不到而失败
- `app/src-tauri/gen/android/keystore.properties`（不进仓库）：

```properties
keyAlias=blinko
password=<你的密码>
storeFile=<绝对路径>/blinko-patch.keystore
storePassword=<你的密码>
```

构建：

```bash
cd app
export ANDROID_HOME=<sdk> NDK_HOME=<sdk>/ndk/<ver>
../node_modules/.bin/tauri.exe android build --target aarch64 --apk
# 产物: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

坑：

- APK 的 `versionName` 来自 `src-tauri/gen/android/app/tauri.properties`（生成文件，容易残留旧版本），版本号不对要手动改，否则应用内更新会一直提示升级并覆盖补丁；
- APK 的前端是编译进 `lib/arm64-v8a/libapp_lib.so` 的（brotli 压缩），**改服务器上的 `public` 对它无效**，必须重打包；
- 换签名安装前先 `adb uninstall com.blinko.app`。

## 部署（NAS，Docker）

```bash
sh patch-tools/deploy.sh <补丁包.zip> [备份目录]
sh patch-tools/rollback.sh <备份目录>
```

`deploy.sh` 会备份容器内 `/app/server/public`、校验包里的 `index-*.js`、`docker cp`（保留旧 assets，缓存页面不会 404）、再重启并回读校验。
**升级 Blinko 镜像会覆盖补丁**，升级后要重跑一次。

## 调试时踩过的坑

1. **本地反向代理必须转发 `/dist/*`**：Vditor 初始化要加载 `/dist/js/lute/lute.min.js`，只转发 `/api/*` 会让编辑器只剩工具栏和白板。表现为"手机端编辑器坏了、电脑端直连正常"。
2. **官方 APK 跨域**：它从自己的壳里调 API，会先发 `OPTIONS` 预检，反向代理不转发就报 `failed to fetch`（浏览器同源，不需要预检，所以浏览器正常）。
3. 卡片手势只响应左滑（`translateX < 0`），所以"右滑打开标签"不会和卡片冲突；冲突只发生在卡片操作面板已经打开的时候，用 `blinko:card-swipe` 事件仲裁。
4. 升级检查：上游 issue #1222 未关闭，1.8.9 也含 `h-0` 隐藏动画问题，升级不会自动修好。
