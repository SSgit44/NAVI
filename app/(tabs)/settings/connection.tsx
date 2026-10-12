import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useGateway } from '@/providers/gateway-provider';
import GatewayAddressPicker from '@/ui/gateway-address-picker';
import { ActionButton, Field, Screen, Section, StatusBanner } from '@/ui/primitives';
import { spacing, useThemeColors } from '@/ui/tokens';

export default function GatewaySettingsScreen(): React.JSX.Element {
  const colors = useThemeColors();
  const gateway = useGateway();
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const connected = gateway.gatewayState === '已连接' && gateway.sessionReady;
  useEffect(() => {
    // 已连接时仍允许留在设置页切换开发板；仅本页重新认证成功后返回监控页。
    if (submitted && connected) router.replace('/monitor');
  }, [connected, submitted]);
  return <Screen>
    <Section title="网关地址" footer="手机和 Jetson 必须位于可互相访问的局域网。">
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        <Text selectable style={{ color: colors.secondaryLabel, fontSize: 14 }}>
          {gateway.discoveryState === 'found'
            ? `已发现 Jetson：${gateway.gatewayAddress}`
            : gateway.discoveryState === 'searching' ? '正在查找 Jetson…' : '请选择要连接的开发板'}
        </Text>
        <GatewayAddressPicker address={gateway.gatewayAddress} onChange={gateway.setGatewayAddress} />
        <ActionButton label={gateway.discoveryState === 'searching' ? '查找中…' : '重新查找 Jetson'} secondary
          disabled={gateway.discoveryState === 'searching'} onPress={() => { void gateway.rediscoverGateway(); }} />
        <Field value={password} onChangeText={setPassword} secureTextEntry placeholder="Ubuntu 用户密码" />
        <ActionButton label={gateway.gatewayState === '连接中' ? '正在验证并连接…' : '验证密码并连接'} disabled={gateway.discoveryState === 'searching' || gateway.gatewayState === '连接中' || !gateway.gatewayAddress.trim() || !password.trim()} onPress={() => { setSubmitted(true); void gateway.checkGateway(password).finally(() => setPassword('')); }} />
        <StatusBanner message={gateway.lastMessage} tone={connected ? 'success' : gateway.gatewayState === '错误' ? 'danger' : 'neutral'} />
      </View>
    </Section>
    {!connected ? <View style={{ gap: spacing.sm }}><ActionButton label="返回独立连接页" secondary onPress={() => router.push('/connection')} /></View> : null}
  </Screen>;
}
