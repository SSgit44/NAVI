#!/usr/bin/env python3
"""独立订阅手机 GPS；不修改 App，不发布任何 ROS 消息。"""

import argparse
import csv
import json
import math
from pathlib import Path
import statistics
import sys
import time
from types import SimpleNamespace


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def gps_data_sample(data):
    """将现有 gps_data JSON 转为内部采样结构，保留未知海拔。"""
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("GPS JSON 必须是对象")
    timestamp = value.get("timestamp_ms")
    if not finite_number(timestamp) or not 0 < timestamp < 1e15:
        raise ValueError("GPS 时间戳无效")
    stamp_ns = round(timestamp * 1_000_000)
    return SimpleNamespace(
        header=SimpleNamespace(stamp=SimpleNamespace(
            sec=stamp_ns // 1_000_000_000, nanosec=stamp_ns % 1_000_000_000)),
        latitude=value.get("latitude"), longitude=value.get("longitude"),
        altitude=value.get("altitude"), status=SimpleNamespace(status=0),
        accuracy_m=value.get("accuracy_m"),
        position_covariance_type=0, position_covariance=[],
    )


def distance_m(lat1, lon1, lat2, lon2):
    """球面水平距离，单位米；适合手机 GPS 的米级误差测试。"""
    a, b = math.radians(lat1), math.radians(lat2)
    h = math.sin((b - a) / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(
        math.radians(lon2 - lon1) / 2) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(max(0, min(1, h))))


def summary(values):
    if not values:
        return "无有效样本"
    ordered = sorted(values)
    p95 = ordered[math.ceil(len(values) * 0.95) - 1]
    return (f"n={len(values)}，均值={statistics.mean(values):.3f}，"
            f"P95={p95:.3f}，最大={max(values):.3f}，"
            f"RMSE={math.sqrt(statistics.mean(v * v for v in values)):.3f}")


FIELDS = (
    "receive_unix_ns", "sample_unix_ns", "latitude", "longitude", "altitude",
    "status", "raw_age_ms", "corrected_delay_ms", "reported_accuracy_m",
    "horizontal_error_m", "displacement_from_first_m", "result",
)


class Measurement:
    def __init__(self, offset_ms=None, reference=None):
        # offset 定义为：开发板系统时间 - 手机系统时间。
        self.offset_ms = offset_ms
        self.reference = reference
        self.seen = set()
        self.first = None
        self.counts = {}
        self.metrics = {key: [] for key in (
            "raw_age_ms", "corrected_delay_ms", "reported_accuracy_m",
            "horizontal_error_m", "displacement_from_first_m",
        )}

    def observe_json(self, data, receive_ns):
        try:
            message = gps_data_sample(data)
        except (ValueError, TypeError, OverflowError):
            # 坏消息单独记录，不能中断后续正常采集。
            self.counts["invalid_json"] = self.counts.get("invalid_json", 0) + 1
            row = dict.fromkeys(FIELDS, "")
            row.update(receive_unix_ns=receive_ns, result="invalid_json")
            return row
        return self.observe(message, receive_ns)

    def observe(self, message, receive_ns):
        stamp = message.header.stamp
        lat, lon = message.latitude, message.longitude
        row = dict.fromkeys(FIELDS, "")
        row.update(receive_unix_ns=receive_ns, latitude=lat, longitude=lon,
                   altitude=message.altitude if finite_number(message.altitude) else "",
                   status=message.status.status)
        if (stamp.sec <= 0 or not 0 <= stamp.nanosec < 1_000_000_000
                or not finite_number(lat) or not -90 <= lat <= 90
                or not finite_number(lon) or not -180 <= lon <= 180
                or message.status.status < 0):
            result = "invalid_fix"
        else:
            sample_ns = stamp.sec * 1_000_000_000 + stamp.nanosec
            row["sample_unix_ns"] = sample_ns
            row["raw_age_ms"] = (receive_ns - sample_ns) / 1_000_000
            # 同一定位会由现有 App 的定时器重复发布；统计只计首次到达。
            if sample_ns in self.seen:
                result = "duplicate"
            else:
                self.seen.add(sample_ns)
                result = "ok"
                if self.offset_ms is not None:
                    delay = row["raw_age_ms"] - self.offset_ms
                    if delay < 0:
                        result = "negative_delay"
                    else:
                        row["corrected_delay_ms"] = delay
                cov = message.position_covariance
                # 本项目将 Expo accuracy 平方写入 x/y 对角项；这不是实测误差。
                accuracy = getattr(message, "accuracy_m", None)
                if finite_number(accuracy) and accuracy >= 0:
                    row["reported_accuracy_m"] = accuracy
                elif (message.position_covariance_type in (1, 2, 3)
                        and len(cov) == 9 and finite_number(cov[0]) and cov[0] >= 0
                        and finite_number(cov[4]) and cov[4] >= 0):
                    row["reported_accuracy_m"] = math.sqrt((cov[0] + cov[4]) / 2)
                if self.reference is not None:
                    row["horizontal_error_m"] = distance_m(lat, lon, *self.reference)
                if self.first is None:
                    self.first = (lat, lon)
                row["displacement_from_first_m"] = distance_m(lat, lon, *self.first)
                for key, values in self.metrics.items():
                    if row[key] != "":
                        values.append(row[key])
        row["result"] = result
        self.counts[result] = self.counts.get(result, 0) + 1
        return row

    def report(self):
        print("\n接收分类：", self.counts, flush=True)
        print("原始数据年龄 ms（含两端时钟偏差）：", summary(self.metrics["raw_age_ms"]))
        if self.offset_ms is not None:
            print("时钟修正延迟 ms：", summary(self.metrics["corrected_delay_ms"]))
        else:
            print("未提供时钟偏差，不生成校准延迟。")
        print("手机报告精度 m（估计值）：", summary(self.metrics["reported_accuracy_m"]))
        if self.reference is not None:
            print("相对 WGS84 参考点水平误差 m：", summary(self.metrics["horizontal_error_m"]))
        else:
            print("未提供参考点，不生成绝对定位误差。")
        print("相对首个定位的水平位移 m（静止时反映漂移）：",
              summary(self.metrics["displacement_from_first_m"]), flush=True)


def self_test():
    """无需 ROS/手机的最小自检，覆盖计时、去重、误差和异常输入。"""
    from types import SimpleNamespace as NS

    msg = NS(header=NS(stamp=NS(sec=1700000000, nanosec=123000000)),
             latitude=0.0, longitude=0.0, altitude=10.0,
             status=NS(status=0), position_covariance_type=2,
             position_covariance=[9, 0, 0, 0, 9, 0, 0, 0, 25])
    received = 1700000000173000000
    measurement = Measurement(20, (0, 0))
    row = measurement.observe(msg, received)
    assert row["raw_age_ms"] == 50 and row["corrected_delay_ms"] == 30
    assert row["horizontal_error_m"] == 0 and row["reported_accuracy_m"] == 3
    assert measurement.observe(msg, received + 500000000)["result"] == "duplicate"
    assert len(measurement.metrics["raw_age_ms"]) == 1
    assert abs(distance_m(0, 0, 0, 1) - 111195.080) < 0.01
    assert distance_m(0, 179.999, 0, -179.999) < 223
    assert Measurement().observe(msg, received)["corrected_delay_ms"] == ""
    assert Measurement(100).observe(msg, received)["result"] == "negative_delay"
    msg.status.status = -1
    assert Measurement().observe(msg, received)["result"] == "invalid_fix"
    msg.status.status = 0
    msg.latitude = float("nan")
    assert Measurement().observe(msg, received)["result"] == "invalid_fix"
    # 新版 App 没有海拔时仍发布 String JSON，水平误差/延迟应正常统计。
    payload = dict(timestamp_ms=1700000000123, latitude=0, longitude=0,
                   altitude=None, accuracy_m=3)
    measurement = Measurement(20, (0, 0))
    row = measurement.observe_json(json.dumps(payload), received)
    assert row["result"] == "ok" and row["altitude"] == ""
    assert row["corrected_delay_ms"] == 30 and row["horizontal_error_m"] == 0
    assert row["reported_accuracy_m"] == 3
    assert measurement.observe_json(json.dumps(payload), received)["result"] == "duplicate"
    for bad in ("{", "[]", '{}', '{"timestamp_ms":true}'):
        assert measurement.observe_json(bad, received)["result"] == "invalid_json"
    payload.update(timestamp_ms=1700000001123, latitude=91)
    assert measurement.observe_json(json.dumps(payload), received)["result"] == "invalid_fix"
    payload.update(timestamp_ms=1700000002123, latitude=0, accuracy_m=None)
    assert measurement.observe_json(json.dumps(payload), received)["reported_accuracy_m"] == ""
    msg.latitude, msg.altitude = 0, float("nan")
    assert Measurement().observe(msg, received)["result"] == "ok"
    print("自检通过：时钟修正、去重、距离、缺失海拔、JSON 解析及异常数据。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--topic", default=None, help="覆盖所选消息格式的默认 GPS 话题")
    parser.add_argument("--message-format", choices=("gps-data", "navsatfix"),
                        default="gps-data", help="gps-data: String JSON（默认）；navsatfix: NavSatFix")
    parser.add_argument("--duration", type=float, default=60, help="采集秒数，默认 60")
    parser.add_argument("--output", default="gps_measurements.csv", help="新 CSV 文件路径")
    parser.add_argument("--clock-offset-ms", type=float,
                        help="开发板时间减手机时间，单位 ms；已验证同步才填 0")
    parser.add_argument("--ref-lat", type=float, help="静止参考点的 WGS84 纬度")
    parser.add_argument("--ref-lon", type=float, help="静止参考点的 WGS84 经度")
    parser.add_argument("--self-test", action="store_true", help="运行离线自检后退出")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.topic is None:
        args.topic = "/phone/gps_data" if args.message_format == "gps-data" else "/phone/gps"
    if not math.isfinite(args.duration) or not 0 < args.duration <= 86400:
        parser.error("duration 必须大于 0 且不超过 86400 秒")
    if args.clock_offset_ms is not None and not math.isfinite(args.clock_offset_ms):
        parser.error("clock-offset-ms 必须是有限数值")
    if (args.ref_lat is None) != (args.ref_lon is None):
        parser.error("ref-lat 与 ref-lon 必须一起提供")
    reference = None
    if args.ref_lat is not None:
        if (not math.isfinite(args.ref_lat) or not -90 <= args.ref_lat <= 90
                or not math.isfinite(args.ref_lon) or not -180 <= args.ref_lon <= 180):
            parser.error("参考坐标范围错误")
        reference = (args.ref_lat, args.ref_lon)
    try:
        import rclpy
        from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
        from sensor_msgs.msg import NavSatFix
        from std_msgs.msg import String
    except ImportError:
        parser.error("请使用已安装 ROS 2 的 Python，并先 source 对应 setup.bash")

    measurement = Measurement(args.clock_offset_ms, reference)
    node = None
    try:
        # x 模式拒绝覆盖已有记录；父目录必须已存在。
        with Path(args.output).expanduser().open("x", newline="", encoding="utf-8") as output:
            writer = csv.DictWriter(output, fieldnames=FIELDS)
            writer.writeheader()
            rclpy.init(args=[])
            node = rclpy.create_node("phone_gps_quality_test")
            qos = QoSProfile(depth=100)
            # BEST_EFFORT 可匹配可靠和尽力而为发布者；测试不改变发布端 QoS。
            qos.reliability = ReliabilityPolicy.BEST_EFFORT
            qos.durability = DurabilityPolicy.VOLATILE

            def receive(message):
                receive_ns = time.time_ns()  # 回调入口先计时，再处理/写盘。
                row = (measurement.observe_json(message.data, receive_ns)
                       if args.message_format == "gps-data"
                       else measurement.observe(message, receive_ns))
                writer.writerow(row)
                output.flush()

            message_type = String if args.message_format == "gps-data" else NavSatFix
            subscription = node.create_subscription(message_type, args.topic, receive, qos)
            print(f"订阅 {args.topic}，采集 {args.duration:g} 秒；CSV："
                  f"{Path(args.output).expanduser().resolve()}", flush=True)
            deadline = time.monotonic() + args.duration
            while rclpy.ok() and time.monotonic() < deadline:
                rclpy.spin_once(node, timeout_sec=min(0.2, max(0, deadline - time.monotonic())))
            # 保留订阅对象直到采集结束。
            del subscription
    except KeyboardInterrupt:
        print("\n用户停止，输出已收到的样本。")
    finally:
        if node is not None:
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    measurement.report()
    if not measurement.seen:
        print("没有有效定位：请检查手机前台状态、话题/消息格式、ROS_DOMAIN_ID 和网络。")
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(f"测试失败：{error}", file=sys.stderr)
        sys.exit(1)
