# 部署准备

这里提供可供后续配置使用的方案；代码不会自动更改任何远程服务器。

## 选择

推荐 **Docker Compose + Nginx + HTTPS**，网页和 API 同源。两核 CPU 可以运行，不要求 GPU。建议 2 GB 内存；照片数量和耗时需要实测，默认只允许一张正在处理。

GitHub 只保存源代码，不必开启 GitHub Pages，也不需要微信小程序资质。

中国大陆服务器若访问 Docker Hub 超时，可按[大陆网络下载源配置](BAOTA_RICE.md#中国大陆网络的项目级下载源)在本项目内指定基础镜像和 Python 包源，不需要调整全局 Docker 服务。

## Docker

服务器安装 Docker Engine 和 Compose 插件后，在仓库目录执行：

```bash
cp .env.example .env
```

在 `.env` 设置随机长口令，例如自己生成至少 32 个随机字符，填在 `RICE_ACCESS_TOKEN=` 后。不要提交 `.env`，它已在 `.gitignore` 中。没有设置口令时，任何能访问网站的人都能调用识别接口。

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8000/api/health
```

健康检查应返回 `status: ok`。容器默认只绑定服务器回环地址；不能直接从手机访问这个地址，需要配置下面的代理。

Docker 镜像使用 Python 3.12、非 root 用户、一个 Uvicorn worker。Compose 限制 2 CPU / 768 MiB、只读文件系统、禁用 core dump，临时目录为内存文件系统。内存较小的服务器应降低图片像素上限和工作图尺寸，而不是增加并发。

## Nginx 和 HTTPS

复制 `deploy/nginx.conf.example` 内容到 Nginx 的站点配置，替换 `YOUR_DOMAIN`。配置文件要处于 Nginx `http` 上下文中。使用域名解析指向服务器，再配置可信 HTTPS 证书。不同系统的 Nginx 配置路径和证书安装方式不同，后续根据服务器系统确定。

保持这些设置：

```nginx
client_max_body_size 20m;
proxy_request_buffering off;
proxy_buffering off;
proxy_max_temp_file_size 0;
proxy_read_timeout 120s;
```

其中 `proxy_request_buffering off` 很关键：避免 Nginx 把大图片缓冲进临时文件。上传接口使用 HTTP/1.1 原始二进制请求，示例也设置了上游 HTTP/1.1。

HTTP 的 80 端口配置只是代理起点。对外使用时应配置 HTTPS，并把 HTTP 重定向到 HTTPS。不要让中间代理启用请求正文存档、图片缓存或上传内容日志。

## 不使用 Docker

按 README 创建 `.venv` 并安装依赖。配置进程管理服务，启动：

```bash
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 .venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log
```

通过进程管理服务的环境配置设置 `RICE_ACCESS_TOKEN`。不把口令写进前端、GitHub 或命令行参数。工作目录须为仓库目录；非 root 运行即可。仍需 Nginx / HTTPS。

## 更新

在服务器仓库没有未提交修改的前提下：

```bash
git pull --ff-only
docker compose up -d --build
```

更新或停止服务会中断正在识别的任务，先等待本次识别结束。没有服务器图片数据需要迁移。

## 常见情况

- **429 / 正在识别另一张**：单任务限制。取消请求后，服务器可能还在完成当前计算，稍等再试。
- **413 / 图片太大**：最大 20 MiB；同时受代理上限约束。
- **422 / 读取失败**：图片格式、像素、方向问题。iPhone HEIC 需转成 JPG。
- **401**：在网页“访问口令与精确修正”里输入 `.env` 中的口令。
- **漏点**：提高灵敏度或降低最小面积，检查遮挡、模糊、白纸对比不足。
- **误点**：降低灵敏度或增大最小面积，避免纸张纹理、深阴影和杂物。
- **内存数字不立刻下降**：内存分配器可能留页复用；应用已删除图片引用。持续多次识别若内存一直增长，则应进一步排查。
