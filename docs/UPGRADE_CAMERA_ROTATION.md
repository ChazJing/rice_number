# 照片旋转与摄像头预览更新

## 已部署网站更新

下载最新 ZIP：https://github.com/ChazJing/rice_number/archive/refs/heads/main.zip

解压后，使用 Xftp 将解压目录中的整个 `frontend` 文件夹上传，覆盖服务器：

```text
/www/wwwroot/rice.chazjing.icu/app/frontend
```

确保 `frontend` 直接位于 `app` 下，不能再嵌套一层 `rice_number-main` 或 `frontend`。新增的 `camera.mjs`、`view.mjs` 也必须上传。完整文件夹包括：

```text
frontend/index.html
frontend/app.mjs
frontend/camera.mjs
frontend/view.mjs
frontend/model.mjs
frontend/style.css
frontend/icon.svg
```

本次没有新增 Python 依赖，不需要修改宝塔配置。更新前端后关闭旧网页再重新打开即可；也可在 Xshell 重启并确认服务：

```bash
systemctl restart rice-number.service
systemctl status rice-number.service --no-pager -l
curl -fsS http://127.0.0.1:8000/api/health
```

第一行一般没有输出。第二行看到 `active (running)`、第三行返回含 `"status":"ok"` 的 JSON 即正常。若显示 `failed`：

```bash
journalctl -u rice-number.service -n 50 --no-pager
```

若还没部署上一轮的识别范围更新，请同时按 [计数更新说明](UPGRADE_COUNTING.md) 覆盖相应后端文件。

## 旋转

选好照片后，在照片下方点击“↻ 旋转”，每次向右旋转90°，四次恢复原方向。每次旋转会重新适应照片区域，再使用放大、缩小和“移动”。

每张照片保留自己的查看方向。红点、黄色复核圈与蓝色识别范围一起转动；旋转不改计数，不丢失手动标记，也不修改上传原图。旋转前后服务器使用同一张原图执行识别。

导出的 JPG 按当前查看方向排版；JSON 的点坐标、尺寸和范围仍对应 EXIF 校正后的原图，并增加 `view_rotation_degrees` 记录查看方向。精确坐标输入也使用原图坐标。

## 摄像头

点击“拍一张”或“拍照”后打开预览窗口：

1. 首次使用时，在浏览器权限提示中允许摄像头。
2. 等待画面清晰。如有多个摄像头，在“切换摄像头”列表中选择需要的设备。
3. 点击“拍摄并使用”，照片进入工作台，继续选择范围、识别和修正。
4. 关闭窗口、按 Esc、拍摄完成或切到其他标签页时，停止已打开的摄像头。取消拍摄会保留已有照片和标记。

需要通过 `https://rice.chazjing.icu/` 打开，并有可用摄像头。程序不请求麦克风权限，不把预览视频传到服务器；只在用户点击“开始识别”后上传拍好的照片。识别计算仍在服务器执行。

权限被拒绝、没有设备或设备被其他软件占用时，窗口会解释原因，并提供重试。部分微信内置浏览器不开放网页摄像头接口，可以点“系统拍照 / 选图”，或在系统浏览器打开。桌面浏览器的系统拍照入口可能仍是文件选择；正常的网页预览入口直接使用摄像头。

## 验证范围

使用 Chromium 与模拟摄像头验证网页流程；不能代替真实电脑摄像头、安卓/iPhone或微信浏览器上的测试。模拟帧与截图放在被 Git 忽略的 `work/` 目录。
