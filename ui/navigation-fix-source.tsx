'use dom';

import { useEffect, useRef } from 'react';
import { CoordinateConverter } from '../services/navigation/coordinate-converter';
import type { PositionSample } from '../services/navigation/route-geometry';

type Sdk = { convertFrom: (point: [number, number], source: string,
  done: (status: string, result: { info?: string; locations?: { lng: number; lat: number }[] }) => void) => void };

/** 根布局持有的坐标转换源；离开地图页仍可发送实测定位，不使用界面推算位置。 */
export default function NavigationFixSource({ apiKey, securityJsCode, sample, onFix, onError }: {
  apiKey: string; securityJsCode: string; sample: PositionSample | null;
  onFix: (sample: PositionSample) => Promise<void>; onError: (message: string) => Promise<void>;
  dom?: import('expo/dom').DOMProps;
}): React.JSX.Element {
  const pending = useRef(sample);
  const callbacks = useRef({ onFix, onError });
  const converter = useRef<CoordinateConverter | null>(null);
  useEffect(() => { callbacks.current = { onFix, onError }; }, [onFix, onError]);
  useEffect(() => {
    let disposed = false;
    const globals = globalThis as unknown as { AMap?: Sdk; _AMapSecurityConfig?: { securityJsCode: string } };
    const ready = (): void => {
      if (disposed || !globals.AMap) return;
      const sdk = globals.AMap;
      const queue = new CoordinateConverter((point, done) => {
        sdk.convertFrom(point, 'gps', (status, result) => {
          const point = result.locations?.[0];
          done(status === 'complete' && result.info === 'ok' && point
            && Number.isFinite(point.lng) && Number.isFinite(point.lat) ? [point.lng, point.lat] : null);
        });
      }, fix => { void callbacks.current.onFix(fix); }, () => { void callbacks.current.onError('实测定位坐标转换失败'); });
      converter.current = queue;
      if (pending.current) queue.submit(pending.current);
    };
    let script: HTMLScriptElement | null = null;
    if (globals.AMap) ready();
    else {
      globals._AMapSecurityConfig = { securityJsCode };
      script = document.createElement('script');
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(apiKey)}`;
      script.onload = ready;
      script.onerror = () => { if (!disposed) void callbacks.current.onError('导航定位服务加载失败，请检查网络'); };
      document.head.appendChild(script);
    }
    return () => { disposed = true; converter.current?.dispose(); converter.current = null; script?.remove(); };
  }, [apiKey, securityJsCode]);
  useEffect(() => { pending.current = sample; if (sample) converter.current?.submit(sample); }, [sample]);
  return <div aria-hidden="true" />;
}
