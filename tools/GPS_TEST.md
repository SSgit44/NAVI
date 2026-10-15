# GPS 延迟与定位准确性测试

独立脚本，不修改 App、网关、ROS 消息或现有配置。脚本运行在开发板，默认订阅已有的 `/phone/gps_data`（`std_msgs/msg/String` JSON），即使海拔为 null 也能测试延迟和水平定位误差；可选择订阅 `/phone/gps`（`sensor_msgs/msg/NavSatFix`）。无需编译 ROS 包或安装 pip 依赖。目标环境为 Ubuntu 20.04+、Python 3.8+、ROS 2 Foxy+；当前环境提供 Humble。脚本只订阅和记录，话题仍由手机 App 发布。

## 测量含义

现有链路为 Expo 手机定位 → App 500 ms 定时发布 → rosbridge（9090）→ ROS 2 → 本脚本回调。JSON 的 `timestamp_ms` 和 NavSatFix 的 `header.stamp` 均来自手机 `location.timestamp`，坐标为 WGS84；高德地图上的 GCJ-02 转换不在该链路内。海拔缺失不影响水平测试，CSV 海拔列留空，不伪造 0。

- 原始数据年龄：`开发板接收 Unix 时间 - 手机定位时间戳`，单位 ms，含两端时钟偏差。
- 时钟修正延迟：`原始数据年龄 - clock-offset-ms`。偏差定义为 **开发板系统时间减手机系统时间**。例如开发板领先手机 20 ms，传 `--clock-offset-ms 20`。只有独立验证时钟同步或测得偏差后，才能将该结果作为延迟估计。自动时间开关本身不能证明毫秒级同步；脚本不自动校准时钟。
- 延迟含定位时间戳之后的系统/回调排队、App 发布等待、网络、rosbridge、DDS 和测试订阅回调排队；不是纯网络耗时，也不是从卫星信号接收开始计时。原代码不暴露回调入口/发送时间，无法在不插桩的条件下拆分这些阶段。
- 绝对准确性：手机放在已知 **WGS84 参考点**上静止采集，计算水平距离误差（米）的均值、P95、最大值和 RMSE。使用平均地球半径的球面距离，适合手机米级测试，不能替代测绘级评估。参考点质量决定结论可信度。不要直接填写高德/百度坐标；移动测试需要逐时刻真值轨迹，本脚本固定参考点模式不适用于移动绝对误差。
- 手机报告精度：JSON 直接读取 `accuracy_m`；NavSatFix 从协方差还原 `sqrt((cov[0]+cov[4])/2)`。它是手机的估计，不是实际误差，也不视为经过验证的统计置信范围。
- 相对首个定位的水平位移：静止测试时可观察漂移；第一个定位不是地理真值，不能把该值当作绝对准确性。没有参考坐标时仍可输出这一指标。

App 会重复发布最近定位。CSV 保留全部接收记录，汇总仅统计每个定位时间戳首次有效到达的消息，避免同一个定位重复加权；因此不能从接收频率推断 GPS 实际采样率或丢包率。不同时间戳即使乱序也分别统计。没有序号/手机源日志，不能证明端到端数据完整性。脚本不筛除大正延迟/大位置误差，以保留异常；修正后负延迟标记为 `negative_delay`，不钳成零、不计入修正延迟，但该条定位仍参与位置统计。测试期间应避免时钟跳变。

## 运行

1. 在开发板启动已有 rosbridge，打开手机 App 的“地图”页，允许精确定位并保持前台。在开阔处等待定位稳定后，把手机放在参考点上静止测试。
2. 将本目录中的 `gps_quality_test.py` 复制到开发板任意可读目录，或使用开发板上的仓库副本。
3. 在开发板终端加载实际安装的 ROS 环境。例如 **确实安装 Humble** 时：

```bash
source /opt/ros/humble/setup.bash
ros2 topic info /phone/gps_data --verbose
ros2 topic echo /phone/gps_data std_msgs/msg/String
```

看到数据后按 Ctrl+C 停止 echo，再运行测试脚本。

Foxy 或其他发行版请把上面路径中的 `humble` 改成实际发行版名称。脚本终端与 rosbridge 使用同一 `ROS_DOMAIN_ID`、兼容的 DDS 配置；测试节点禁用仿真时间，直接用系统 Unix 时间与手机时间戳比较。

以下命令假设仓库确实位于本机当前路径；复制到开发板后按实际路径替换：

```bash
# 先离线自检，不需要 ROS 初始化，也不连接手机。
python3 /home/shu/NAVI/Jetson_ROS2_APP/tools/gps_quality_test.py --self-test

# 未校准时钟/没有参考点时，先记录原始数据年龄、手机精度估计和漂移。
python3 /home/shu/NAVI/Jetson_ROS2_APP/tools/gps_quality_test.py \
  --duration 60 --output /tmp/gps_measurements.csv
```

已验证时钟同步并取得 WGS84 参考坐标后使用下面模板。`参考纬度`、`参考经度`必须替换为真实数值；偏差不是零时修改 `--clock-offset-ms`：

```bash
python3 /home/shu/NAVI/Jetson_ROS2_APP/tools/gps_quality_test.py \
  --duration 120 --clock-offset-ms 0 \
  --ref-lat 参考纬度 --ref-lon 参考经度 \
  --output /tmp/gps_reference_test.csv
```

输出路径的父目录需已存在且可写，已有文件拒绝覆盖。重复运行请换文件名。Ctrl+C 会保留已接收记录并输出汇总。未收到有效定位返回码为 2；运行错误为 1；收到有效定位正常结束为 0。返回 0 仅表示采集成功，不代表延迟/准确性达标；应按项目需求评估统计值。

如需测试旧 NavSatFix 话题，执行：

```bash
python3 /home/shu/NAVI/Jetson_ROS2_APP/tools/gps_quality_test.py \
  --message-format navsatfix --duration 60 --output /tmp/gps_navsatfix.csv
```

此模式默认话题为 `/phone/gps`。`--topic` 只修改话题名，不改变消息类型；不要将 String 话题与 NavSatFix 格式混用。当前 App 缺少海拔时只发布 `/phone/gps_data`，因此优先使用默认模式。

## 需要调整的位置

| 设置 | 修改位置 | 默认值/说明 |
|---|---|---|
| 测试脚本位置 | 运行命令中 `python3` 后的绝对路径 | 替换成开发板实际保存脚本的路径 |
| ROS 环境位置 | `source` 命令的绝对路径 | 按实际发行版填写，无需改脚本 |
| CSV 保存路径 | 命令参数 `--output` | 默认当前工作目录 `gps_measurements.csv` |
| 消息格式 | 命令参数 `--message-format` | `gps-data`（默认）或 `navsatfix` |
| GPS 话题 | 命令参数 `--topic` | 默认随格式选择 `/phone/gps_data` 或 `/phone/gps` |
| 测试时长 | 命令参数 `--duration` | 60 秒，最大 86400 秒 |
| 两端时钟偏差 | 命令参数 `--clock-offset-ms` | 默认未知，只有提供后输出修正延迟 |
| 参考坐标 | 命令参数 `--ref-lat` 和 `--ref-lon` | 必须一起填写，WGS84，单位度 |

这些设置都通过命令行完成，不需要修改项目中的路径常量。

## CSV 与排查

每条消息记录接收/采样 Unix 纳秒时间、经纬度、海拔、定位状态、原始数据年龄、修正延迟、手机精度估计、水平误差、相对首点位移及结果分类。无法计算的指标留空；`invalid_json` 表示 JSON 结构或时间戳无效，`invalid_fix` 表示状态无定位、时间戳异常或经纬度无效，`duplicate` 表示同一定位已统计，`negative_delay` 提示偏差或时间异常，`ok` 表示有效首次采样。String JSON 没有 ROS 定位状态字段，脚本内部用 0 表示可处理的采样，不据此推断卫星锁定状态。

订阅使用 `BEST_EFFORT / VOLATILE / KEEP_LAST(100)` 以兼容可靠和尽力而为发布者。它测量测试节点实际收到的数据，不保证捕获所有发布。长时间采集的汇总及去重记录保存在内存中，CSV 每条刷新；建议每次采集 1–5 分钟。

没有数据时，先检查 `ros2 topic echo /phone/gps_data std_msgs/msg/String`、话题发布者、手机权限与前台状态、网络和 ROS_DOMAIN_ID；确保手机加载的是当前分支的 App。新版 App 在海拔缺失时仍发布 `/phone/gps_data`，但会暂停 `/phone/gps`。时延偏大时先排除时钟偏差，再观察 App 定时发布与重复旧定位；不把异常延迟自动当成网络问题。定位误差偏大时检查参考坐标系及测试环境。
