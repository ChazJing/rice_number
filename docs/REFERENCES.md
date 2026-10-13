# 公开参考资料

仅参考公开的任务设计和方法，没有复制商业软件代码、模型或界面素材，也没有使用他人照片作为提交资产。

1. [精点相机官方 App Store 介绍](https://apps.apple.com/cn/app/%E7%B2%BE%E7%82%B9%E7%9B%B8%E6%9C%BA/id1627219849)：公开介绍拍照计数与人工纠正功能。本项目借鉴自动结果可人工修正的交互思想，不采用其商业模型或精度宣传。
2. [点数相机官方 App Store 介绍](https://apps.apple.com/cn/app/%E7%82%B9%E6%95%B0%E7%9B%B8%E6%9C%BA-%E5%95%A5%E9%83%BD%E8%83%BD%E6%95%B0-%E6%95%B0%E9%92%A2%E7%AE%A1-%E6%95%B0%E7%AB%B9%E7%AD%BE-%E6%95%B0%E9%92%A2%E7%AD%8B/id1568634122)：公开介绍拍照/上传计数。当前项目仅覆盖水稻种子。
3. [Size measurement and filled/unfilled detection of rice grains using backlight image processing, Frontiers in Plant Science (2023)](https://www.frontiersin.org/journals/plant-science/articles/10.3389/fpls.2023.1213486/full)：展示水稻图像预处理、二值化和分水岭分离的研究路线。该研究采用背光专用装置，与白纸手机拍摄不同，不能将其实验精度移用到本工具。
4. [Image analysis-based recognition and quantification of grain number per panicle in rice, Plant Methods (2019)](https://link.springer.com/article/10.1186/s13007-019-0510-0)：讨论连通区域计数以及粘连情况下分水岭等方法的局限。

本工具的白纸阴影校正、服务器接口和标点状态管理是独立实现。分水岭调用 scikit-image 的开源实现，依赖包的许可随其发行包保留。
