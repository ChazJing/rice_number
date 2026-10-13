# 宝塔部署 rice.chazjing.icu：从本机下载到网站上线

适用于已经使用宝塔管理原网站、尚未安装 Docker 的 Linux 服务器。仅为水稻工具创建新站点，原网站目录是 `/www/wwwroot/chazjing.icu`。

部署完成后的访问地址：`https://rice.chazjing.icu/`。

## 1. 下载到 Windows 桌面 GPT 文件夹

在 Windows 开始菜单搜索并打开 **PowerShell**。以下命令在你的 Windows 电脑运行，不能放到服务器终端：

```powershell
$riceDownloadDir = 'C:\Users\zhengshijing\Desktop\GPT'
$riceZipPath = Join-Path $riceDownloadDir 'rice_number-main.zip'
New-Item -ItemType Directory -Path $riceDownloadDir -Force | Out-Null
Invoke-WebRequest -Uri 'https://github.com/ChazJing/rice_number/archive/refs/heads/main.zip' -OutFile $riceZipPath
Expand-Archive -LiteralPath $riceZipPath -DestinationPath $riceDownloadDir
```

结果：

```text
C:\Users\zhengshijing\Desktop\GPT\rice_number-main.zip
C:\Users\zhengshijing\Desktop\GPT\rice_number-main\
```

没有使用 `Expand-Archive -Force`，以免覆盖已有文件。若目标下已经有 `rice_number-main`，先选用不同下载目录；不要删除自己的旧文件。

也可以从 [GitHub 下载 ZIP](https://github.com/ChazJing/rice_number/archive/refs/heads/main.zip)，手动保存到该文件夹并解压。

聊天的云端执行环境无法直接写入你的电脑 C 盘。以上命令在你电脑运行后，才会实际保存到指定路径。仅备份源代码不需要在电脑安装 Python 或 Docker。

## 2. 添加子域名 DNS

进入 `chazjing.icu` 的 DNS 管理页面，新增：

| 字段 | 值 |
|---|---|
| 记录类型 | A |
| 主机记录/名称 | rice |
| 记录值 | 服务器公网 IPv4 |
| TTL | 默认 |

不要把域名的 `https://` 前缀填进主机记录。记录值填 IP，不填网址。若已经存在 `rice` 的记录，核对并修改同名记录，而不是添加冲突记录。

原来的根域名记录无需修改。若 DNS 提供商支持代理/CDN，首次部署先使用仅 DNS 模式。使用有错误地址的 AAAA 记录也可能影响访问或证书申请。

在 Windows PowerShell 检查：

```powershell
Resolve-DnsName rice.chazjing.icu -Type A
```

看到服务器公网 IP 后继续。云厂商安全组和宝塔防火墙需要允许 TCP 80、443；内部识别端口 8000 只绑定回环地址，无须对公网开放。

## 3. 在宝塔安装 Docker

登录现有宝塔面板，打开左侧 **Docker**，按面板提示安装 Docker 服务。入口名称随面板版本略有差异；旧版可能通过软件商店提供 Docker 管理入口。安装后打开宝塔“终端”，执行：

```bash
docker --version
docker compose version
```

两条都应显示版本。如果第二条提示找不到 compose，Docker Compose 插件尚未就绪，应先解决再部署。不要为了这个工具重新安装宝塔、Nginx、PHP 或数据库。

检查机器资源及内部端口：

```bash
free -h
df -h /www
ss -lntp 'sport = :8000'
```

建议总内存 2 GB，磁盘预留至少约 3 GB 给构建和镜像。若现有网站也在运行，需看剩余资源。8000 端口如果已有监听，后面按“端口冲突”说明改为其他回环端口。

## 4. 创建独立目录与新站点

在宝塔“文件”中创建：

```text
/www/wwwroot/rice.chazjing.icu/
├── app/       # 工具代码，后面上传到这里
└── public/    # 宝塔的网站根目录，作为证书验证目录
```

也可以在服务器终端执行：

```bash
mkdir -p /www/wwwroot/rice.chazjing.icu/app
mkdir -p /www/wwwroot/rice.chazjing.icu/public
```

宝塔“网站”→“添加站点”：

| 项目 | 填写 |
|---|---|
| 域名 | rice.chazjing.icu |
| 根目录 | /www/wwwroot/rice.chazjing.icu/public |
| PHP | 纯静态（若界面要求选择） |
| 数据库 | 不创建 |
| FTP | 不创建 |

“纯静态”只是让宝塔建一个 Nginx 站点。真正的 Python 识别服务将在 Docker 内运行。不要把站点根目录设为 `app`，否则反向代理未配置时可能暴露代码或 `.env`。

## 5. 先配置 SSL

在新站点 `rice.chazjing.icu` 的设置中打开 **SSL**，申请 Let's Encrypt 证书，勾选该子域名。先保持反向代理关闭，以便 HTTP 文件验证访问站点根目录。

证书签发并部署后，确认 HTTPS 可以打开新站点的默认页，再开启 **强制 HTTPS**。如果已有覆盖 `*.chazjing.icu` 的有效通配符证书，也可以导入；仅覆盖根域名 `chazjing.icu` 的证书不能直接覆盖这个子域名。

此时出现默认网页属于正常，下一步才接入工具。

## 6. 上传代码并启动识别服务

在宝塔“文件”中打开：

```text
/www/wwwroot/rice.chazjing.icu/app
```

上传本机下载的 `rice_number-main.zip`，用宝塔解压。通常会多出 `rice_number-main` 文件夹，把这个文件夹里面的内容移动到 `app`，包含 `.dockerignore`、`.env.example` 等隐藏文件。目标结构应为：

```text
app/
├── Dockerfile
├── compose.yaml
├── requirements.txt
├── .env.example
├── backend/
├── frontend/
└── ...
```

在宝塔终端运行：

```bash
cd /www/wwwroot/rice.chazjing.icu/app
test -f Dockerfile && test -f compose.yaml && test -f .env.example
```

检查文件成功后，通过宝塔文件编辑器新建 `.env`，内容：

```dotenv
RICE_ACCESS_TOKEN=替换为自己设置的长随机口令
```

建议用密码管理器生成至少 32 位随机口令，只放在 `.env` 中，不提交到 GitHub，不把口令发到聊天。网页使用时，在“访问口令与精确修正”里输入这个口令。

随后运行：

```bash
cd /www/wwwroot/rice.chazjing.icu/app
docker compose -p rice_number up -d --build
docker compose -p rice_number ps
curl -fsS http://127.0.0.1:8000/api/health
```

首次需要下载基础镜像和 Python 依赖，可能要几分钟。容器正常时，最后一条应返回包含 `"status":"ok"` 和 `"requires_token":true` 的 JSON。

此时识别服务只监听服务器本地。外网浏览器还不能通过 8000 访问，这是预期配置。

### 如果 8000 端口冲突

在 `compose.yaml` 中把：

```yaml
- "127.0.0.1:8000:8000"
```

改成例如：

```yaml
- "127.0.0.1:18080:8000"
```

先确认 18080 空闲，再启动。健康检查改用 `127.0.0.1:18080`，下面的 Nginx `proxy_pass` 也同步改为 18080。右边的容器端口 8000 不改。

## 7. 把新域名代理到识别服务

在宝塔 **网站 → rice.chazjing.icu → 配置文件** 操作。不要打开原网站的配置，也不要直接替换全局 `nginx.conf`。

先保存一份这个新站点的配置备份。保留宝塔已有的 SSL 证书设置、验证目录和 include。若 `server { ... }` 内已有 `client_max_body_size`，把值改成 `20m`；没有时在该块内添加：

```nginx
client_max_body_size 20m;
```

然后在同一个 `server { ... }` 块内添加 [两个 location 配置块](../deploy/baota-rice-locations.conf.example)。如果已经有 `location / { ... }`，替换该块，不能再放一个重复的 `/` 块。此教程手动配置，不要再在“反向代理”选项卡创建同样的规则。

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /www/wwwroot/rice.chazjing.icu/public;
    default_type text/plain;
    try_files $uri =404;
}

location ^~ / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_max_temp_file_size 0;
    proxy_read_timeout 120s;
    proxy_send_timeout 60s;
}
```

`^~ /` 确保宝塔默认的 CSS/图片正则规则不会把工具资源错误地当作本地静态文件。更长的 ACME 验证路径则留给证书续期。

`proxy_request_buffering off` 避免 Nginx 把上传图片缓冲到磁盘。不要启用代理缓存或请求正文存档。

保存后先测试配置语法，再在宝塔 Nginx 管理页面 **重载配置**：

```bash
/www/server/nginx/sbin/nginx -t
```

这一步假设你使用宝塔安装的 Nginx。若该路径不存在或原站是 Apache/OpenLiteSpeed，应根据实际 Web 服务器调整，不要重装原站服务。Nginx 测试若报告重复 location，检查本新站点是否另有代理规则；只修改新站点。

## 8. 打开并验证

打开 `https://rice.chazjing.icu/`，应看到“稻粒”页面。

1. 在“访问口令与精确修正”输入 `.env` 中的口令。
2. 上传一张水稻照片并识别。
3. 检查补点、删点、撤销、导出是否正常。
4. 换第三张照片，确认只保留最近两张。
5. 在手机系统浏览器试拍照。iPhone HEIC 请切换兼容格式或转为 JPG。

服务器状态与日志：

```bash
cd /www/wwwroot/rice.chazjing.icu/app
docker compose -p rice_number ps
docker compose -p rice_number logs --tail 50
```

只操作这个 Compose 项目，不能执行全局清理 Docker 容器/镜像等命令。要停止本工具，使用 `docker compose -p rice_number stop`。

## 常见错误

| 现象 | 优先检查 |
|---|---|
| 域名解析失败 | DNS 的 rice 记录、记录值与生效情况 |
| SSL 申请失败 | DNS、80 端口、是否提前打开反向代理 |
| 502 | 容器状态、健康接口、proxy_pass 端口 |
| 页面无样式/图标 | location 是否为 ^~ /，是否还有重复代理规则 |
| 401 | 输入正确口令；修改 .env 后需重新执行 up -d |
| 413 | 上传照片大小；新站点 Nginx 的 client_max_body_size |
| 429 | 一次只处理一张；等当前计算完成 |
| 构建下载失败 | 镜像仓库或 Python 包源的网络，先保留错误信息 |

### Docker Hub 超时

如果日志在 `docker-image://docker.io/docker/dockerfile:1` 处超时，这是较早版本 Dockerfile 第一行 `# syntax=docker/dockerfile:1` 引发的额外构建前端下载。最新版已移除这一行，使用 Docker 自带的 BuildKit 前端。旧文件可以在本项目目录中修正：

```bash
cd /www/wwwroot/rice.chazjing.icu/app
sed -i '\|^# syntax=docker/dockerfile:1$|d' Dockerfile
docker compose -p rice_number up -d --build
```

这只能消除额外的前端镜像下载；`python:3.12-slim` 基础镜像仍需从 Docker Hub 拉取。如果下一次日志在 `python:3.12-slim` 处访问 `registry-1.docker.io` 超时，说明基础镜像下载也被服务器网络阻断，需要使用可信的可达镜像渠道或离线导入，不能只靠重试或修改 Compose 权限解决。

这种情况下，不要为本项目随意修改全局 Docker 配置或重启 Docker 守护进程，以免影响同机已有服务。先保留具体报错，再选择项目级镜像来源或离线部署方式。

## 官方参考

- [宝塔面板新手指南](https://docs.bt.cn/landing/getting-started/)
- [宝塔反向代理配置](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)
- [宝塔网站 SSL 配置](https://docs.bt.cn/user-guide/site/php/site-config/ssl)
- [Docker Compose 插件安装说明](https://docs.docker.com/compose/install/linux/)
