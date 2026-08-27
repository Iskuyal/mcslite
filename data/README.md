运行期自动生成的目录。这里放一个占位文件，仅为在仓库里保留目录结构。

首次启动会在本目录生成（**都属于机密/状态，不要提交**）：

- `settings.json`       面板配置（可编辑、可拷贝到别机）
- `credentials.json`    登录口令的 scrypt 散列（机密）
- `secret.key`          会话 token 的 HMAC 签名密钥（机密；删掉=全员重新登录）
- `mcslite.db`          操作审计日志（node:sqlite；不可用时为 oplog.jsonl）
- `sampler.ps1`         由面板从 JS 内嵌写出的指标采样脚本
- `logs/panel.log`      面板自身输出（start.ps1 落盘）
- `logs/panel-console.log`  服务端控制台镜像（4MB 轮转，用于历史回放）

备份只要备 `settings.json` + `credentials.json` + `secret.key` + `mcslite.db`。
