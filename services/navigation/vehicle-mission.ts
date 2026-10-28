import { routePayload } from './navigation-publisher';
import type { NavigationRoute } from './route-geometry';

export const VEHICLE_COMMAND_TOPIC = '/phone/navigation/command';
export const VEHICLE_FIX_TOPIC = '/phone/navigation/fix';
export const VEHICLE_FEEDBACK_TOPIC = '/wheel/navigation/feedback';
export const VEHICLE_MESSAGE_TYPE = 'std_msgs/msg/String';
export type VehicleFeedback = {
  session_id: string; mission_id: string; state: string; reason: string;
  remaining_m: number | null; uncertainty_m: number | null; command_error: string;
};
type Send = (topic: string, message: { data: string }) => void;

/** 车辆任务不缓存、不回放；每次开始都绑定开发板当前会话。 */
export class VehicleMission {
  private connected = false;
  private session = '';
  private mission = '';
  private sequence = 0;
  private lastFeedback = -Infinity;
  private startedAt = 0;
  feedback: VehicleFeedback | null = null;

  constructor(private readonly send: Send) {}
  get active(): boolean { return !!this.mission; }
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) { this.mission = ''; this.session = ''; this.feedback = null; }
  }
  receive(raw: unknown, now: number): void {
    if (!this.connected || typeof raw !== 'string') return;
    try {
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      const value = data as Record<string, unknown>;
      if (value.version !== 1 || typeof value.session_id !== 'string' || !value.session_id
        || typeof value.mission_id !== 'string' || typeof value.state !== 'string' || typeof value.reason !== 'string'
        || typeof value.command_error !== 'string'
        || ![value.remaining_m, value.uncertainty_m].every(v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))) return;
      if (this.session && this.session !== value.session_id) this.mission = '';
      this.session = value.session_id;
      this.lastFeedback = now;
      this.feedback = value as unknown as VehicleFeedback;
      if (value.mission_id === this.mission && !['running', 'approaching', 'stopping'].includes(value.state)) this.mission = '';
    } catch { /* 异常反馈不能刷新会话或任务心跳。 */ }
  }
  start(route: NavigationRoute, now: number): string {
    if (!this.connected || !this.session || now - this.lastFeedback > 1500) throw new Error('请等待开发板导航节点反馈');
    if (this.active) throw new Error('请先停止当前轮椅任务');
    const id = `mission-${now}-${Math.random().toString(36).slice(2, 12)}`;
    this.sequence = 0;
    this.startedAt = now;
    this.command('start', id, now, { route: routePayload(route) });
    this.mission = id;
    return id;
  }
  heartbeat(now: number): void {
    if (!this.active) return;
    if (now - this.lastFeedback > 1500 || (now - this.startedAt > 2000 && this.feedback?.mission_id !== this.mission)) {
      this.cancel(now);
      return;
    }
    this.command('heartbeat', this.mission, now, { sequence: ++this.sequence });
  }
  cancel(now: number): void {
    const id = this.mission;
    this.mission = '';
    if (id && this.connected && this.session) this.command('cancel', id, now);
  }
  private command(command: string, id: string, now: number, extra: object = {}): void {
    this.send(VEHICLE_COMMAND_TOPIC, { data: JSON.stringify({
      version: 1, command, session_id: this.session, mission_id: id, issued_at_ms: now, ...extra,
    }) });
  }
}
