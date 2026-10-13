# 大陆服务器直接运行 Python（无需 Docker 镜像）

适用于 Docker Hub 不可达、公共镜像服务也返回 502 或超时的情况。改为本项目独立的 Python 虚拟环境，依赖使用清华 PyPI 源。仍在服务器 CPU 上识别，接口、网页、图片内存清理和 Nginx 代理方式完全相同。

部署目录：`/www/wwwroot/rice.chazjing.icu/app`。域名仍为 `rice.chazjing.icu`，内部端口仍为 8000。

## 1. 确认 Python

在 Xshell 执行：

```bash
python3 --version
cat /etc/os-release
```

当前代码支持 Python **3.10–3.13**，Ubuntu 22.04 常用的系统 Python 3.10 可以使用。依赖文件会为 3.10 选择兼容的 NumPy / SciPy 版本。如果已有 3.12，也可直接使用。只有系统 Python 低于 3.10 时，才需要在宝塔“网站 → Python 项目”的环境管理中安装独立的 Python 3.12 项目运行环境。入口名称因版本而异。

安装的是项目运行环境，不需要升级宝塔面板自身的 Python，也不要替换系统 `/usr/bin/python3`。实际 Python 路径以宝塔环境列表为准，常见基础版本目录位于 `/www/server/pyporject_evn/versions/`。

## 2. 安装本项目依赖

Python 3.10 用户需要先把最新版 `backend/app.py`、`requirements.txt`、`deploy/install-native.sh` 和 `deploy/rice-number.service.example` 更新到项目的对应位置。前端和原照片识别算法无需更换。可以在 Windows 下载最新 ZIP 后，用 Xftp 只覆盖这四个文件，保留服务器上的 `.env` 和网站配置。

```bash
cd /www/wwwroot/rice.chazjing.icu/app
bash deploy/install-native.sh
```

脚本自动选择 PATH 中的兼容 Python，在项目 `.venv` 创建环境，仅在该环境内安装 `requirements.txt`，默认使用 `https://pypi.tuna.tsinghua.edu.cn/simple`。不修改全局 pip 设置或其他项目依赖。

如果 Python 是由宝塔安装、但没有加入 PATH，明确指定环境列表显示的可执行文件路径，例如：

```bash
RICE_PYTHON=/实际路径/bin/python3 bash deploy/install-native.sh
```

Ubuntu 22.04 若系统 Python 为 3.10、创建虚拟环境提示缺少 ensurepip，可以安装 venv 支持后重试：

```bash
apt-get update
apt-get install -y python3.10-venv
bash deploy/install-native.sh
```

这些命令添加系统 Python 3.10 的虚拟环境支持，不更换系统 Python，也不安装其他应用的 Python 依赖。

若创建环境时提示 `ensurepip` / `venv` 不可用，需要按实际系统安装该版本的 venv 支持；先保留完整报错。不能通过把依赖装进系统 Python 来替代独立环境。

## 3. 前台验证

检查 8000 是否空闲：

```bash
ss -lntp 'sport = :8000'
```

如果已经有本工具或其他服务监听，应先辨认占用者。只有本工具的旧容器需要停下时，才在本项目目录使用 `docker compose -p rice_number stop`；不停止其他容器。

端口空闲后，在一个 Xshell 窗口运行：

```bash
cd /www/wwwroot/rice.chazjing.icu/app
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log
```

另开一个 Xshell 窗口验证：

```bash
curl -fsS http://127.0.0.1:8000/api/health
```

应返回 `status: ok`。前台验证阶段没有自动读取 `.env`；用户选择不设口令时可直接测试。需要口令的部署由下面 systemd 的 `EnvironmentFile` 读取。

验证完成后，回到第一个窗口按 Ctrl+C 停止前台进程，再安装常驻服务。不要把前台测试进程和常驻服务同时启动在同一端口。

## 4. 配置常驻服务

以下针对 Linux systemd，使用独立账号 `rice-counter`。命令需要 root；只设置本工具的账号、代码所有者及 `rice-number.service`，不修改其他站点或全局 Python。

```bash
cd /www/wwwroot/rice.chazjing.icu/app
id rice-counter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin rice-counter
chown -R rice-counter:rice-counter /www/wwwroot/rice.chazjing.icu/app
cp deploy/rice-number.service.example /etc/systemd/system/rice-number.service
systemctl daemon-reload
systemctl enable --now rice-number.service
systemctl status rice-number.service --no-pager
curl -fsS http://127.0.0.1:8000/api/health
```

如果已有同名账号或服务且不是本工具，应换成专用名称，而不是覆盖。`.env` 可保持 `RICE_ACCESS_TOKEN=`，代表不设访问口令。运行账号需要能够读取 Python 基础运行环境；因此避免使用存放于 `/root` 内的 Python。

服务限制 2 核 CPU 配额和 768 MiB 内存，禁止 core dump，项目在运行时只读。它不会在服务器保存上传图片。操作系统层面的交换区和反向代理配置仍需按原隐私说明管理。

查看日志：

```bash
journalctl -u rice-number.service -n 50 --no-pager
```

修改代码或 `.env` 后仅重启本工具：

```bash
systemctl restart rice-number.service
```

## 5. Nginx 和 HTTPS

继续使用 [宝塔教程的反向代理步骤](BAOTA_RICE.md#7-把新域名代理到识别服务)，目标仍为 `http://127.0.0.1:8000`。保留 `proxy_request_buffering off`，防止图片上传被写入代理临时文件。网站根目录仍应为 `public`，程序留在 `app`。

先通过本机健康检查，再访问 `https://rice.chazjing.icu/` 验证上传、自动红点和人工修正。

## 参考

- [Python 虚拟环境说明](https://docs.python.org/zh-cn/3.12/library/venv.html)
- [清华 PyPI 镜像说明](https://mirror.tuna.tsinghua.edu.cn/help/pypi/)
- [宝塔 Python 环境与项目管理说明](https://docs.bt.cn/ai-ops/mcp/tools-reference/)
