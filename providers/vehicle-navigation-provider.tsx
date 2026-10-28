import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useRosbridge } from './rosbridge-provider';
import { usePhoneSensors } from './phone-sensors-provider';
import { loadAmapCredentials, type AmapCredentials } from '@/services/amap-credentials';
import { VehicleMission, VEHICLE_COMMAND_TOPIC, VEHICLE_FEEDBACK_TOPIC, VEHICLE_FIX_TOPIC, VEHICLE_MESSAGE_TYPE,
  type VehicleFeedback } from '@/services/navigation/vehicle-mission';
import type { NavigationRoute, PositionSample } from '@/services/navigation/route-geometry';
import NavigationFixSource from '@/ui/navigation-fix-source';

type Context = { start: (route: NavigationRoute) => void; stop: () => void; active: boolean;
  feedback: VehicleFeedback | null; message: string };
const VehicleContext = React.createContext<Context | null>(null);

/** 根级任务服务：切换页面不会丢任务；后台/断线只停车，回到前台必须重新开始。 */
export function VehicleNavigationProvider({ children }: React.PropsWithChildren): React.JSX.Element {
  const { connectionState, advertiseTopic, unadvertiseTopic, publishTopic, subscribeTopic } = useRosbridge();
  const { latestGps, latestHeading } = usePhoneSensors();
  const [credentials, setCredentials] = useState<AmapCredentials | null>(null);
  const [feedback, setFeedback] = useState<VehicleFeedback | null>(null);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState('等待开发板导航反馈');
  const foreground = useRef(AppState.currentState === 'active');
  const sensorRef = useRef({ latestHeading, connectionState });
  const lastFix = useRef(-Infinity);
  useEffect(() => { sensorRef.current = { latestHeading, connectionState }; }, [latestHeading, connectionState]);
  const mission = useMemo(() => new VehicleMission((topic, msg) => {
    advertiseTopic(topic, VEHICLE_MESSAGE_TYPE); publishTopic(topic, msg);
  }), [advertiseTopic, publishTopic]);
  useEffect(() => { void loadAmapCredentials().then(setCredentials).catch(() => setMessage('读取定位服务配置失败')); }, []);
  useEffect(() => {
    mission.setConnected(connectionState === 'connected');
  }, [connectionState, mission]);
  useEffect(() => subscribeTopic(VEHICLE_FEEDBACK_TOPIC, VEHICLE_MESSAGE_TYPE, msg => {
    mission.receive(msg.data, Date.now());
    setFeedback(mission.feedback); setActive(mission.active);
    if (mission.feedback) setMessage(mission.feedback.command_error || mission.feedback.reason);
  }, { throttleRate: 200, queueLength: 1 }), [mission, subscribeTopic]);
  const stop = useCallback(() => {
    try { mission.cancel(Date.now()); } catch { /* 开发板心跳超时同样会停车。 */ }
    setActive(false);
  }, [mission]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current) { stop(); setMessage('应用进入后台，任务已停止；回到前台后请重新开始'); }
    });
    const timer = setInterval(() => {
      if (!foreground.current) return;
      try { mission.heartbeat(Date.now()); } catch { stop(); }
      setActive(mission.active);
    }, 500);
    return () => { subscription.remove(); clearInterval(timer); stop(); };
  }, [mission, stop]);
  useEffect(() => () => {
    unadvertiseTopic(VEHICLE_COMMAND_TOPIC); unadvertiseTopic(VEHICLE_FIX_TOPIC);
  }, [unadvertiseTopic]);
  const onFix = useCallback(async (fix: PositionSample): Promise<void> => {
    const { latestHeading: heading, connectionState: connection } = sensorRef.current;
    if (!foreground.current || connection !== 'connected' || !heading || fix.timestamp <= lastFix.current) return;
    // 原始 GPS 的时间、精度保持不变；只变换坐标，绝不发送地图上的推算位置。
    try {
      advertiseTopic(VEHICLE_FIX_TOPIC, VEHICLE_MESSAGE_TYPE);
      publishTopic(VEHICLE_FIX_TOPIC, { data: JSON.stringify({
        version: 1, coordinate_system: 'GCJ-02', source: 'measured',
        longitude: fix.position[0], latitude: fix.position[1], accuracy_m: fix.accuracyM, timestamp_ms: fix.timestamp,
        heading_degrees: heading.headingDegrees, heading_source: heading.source,
        heading_timestamp_ms: heading.timestamp, heading_accuracy: heading.accuracy,
      }) });
      lastFix.current = fix.timestamp;
    } catch { setMessage('导航定位发送失败'); }
  }, [advertiseTopic, publishTopic]);
  const onError = useCallback(async (error: string) => { setMessage(error); }, []);
  const sample = useMemo<PositionSample | null>(() => latestGps ? ({
    position: [latestGps.longitude, latestGps.latitude], timestamp: latestGps.timestamp,
    accuracyM: latestGps.accuracy, speedMps: latestGps.speedMps,
  }) : null, [latestGps]);
  const start = useCallback((route: NavigationRoute) => {
    if (!foreground.current) throw new Error('请保持应用在前台');
    if (Date.now() - lastFix.current > 3000) throw new Error('请等待新的实测导航定位');
    mission.start(route, Date.now()); setActive(true); setMessage('任务已发送，等待开发板接受');
  }, [mission]);
  const connected = connectionState === 'connected';
  return <VehicleContext value={{ start, stop, active: connected && active,
    feedback: connected ? feedback : null,
    message: connected ? message : '连接中断，轮椅任务不会自动恢复' }}>
    {children}
    {credentials ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
      <NavigationFixSource apiKey={credentials.apiKey} securityJsCode={credentials.securityJsCode}
        sample={sample} onFix={onFix} onError={onError}
        dom={{ useExpoDOMWebView: false, scrollEnabled: false, style: { width: 1, height: 1 } }} />
    </View> : null}
  </VehicleContext>;
}

export function useVehicleNavigation(): Context {
  const value = React.use(VehicleContext);
  if (!value) throw new Error('缺少 VehicleNavigationProvider');
  return value;
}
