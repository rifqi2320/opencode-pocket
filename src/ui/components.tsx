import React, { PropsWithChildren, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, PressableProps, StyleProp, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { makeStyles, radius, space, type, usePalette, type Palette } from './theme';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';
export const toneColor = (c: Palette, tone: Tone) => tone === 'success' ? c.success : tone === 'warning' ? c.warning : tone === 'danger' ? c.danger : c.faint;
const toneSoft = (c: Palette, tone: Tone) => tone === 'success' ? c.successSoft : tone === 'warning' ? c.warningSoft : tone === 'danger' ? c.dangerSoft : c.surfaceAlt;
const webOnly = (value: Record<string, unknown>) => (Platform.OS === 'web' ? value : {}) as Record<string, unknown>;

/** Stroke icons (Lucide geometry, 24px grid). */
const paths = {
  back: ['M15 18l-6-6 6-6'],
  chevron: ['M9 18l6-6-6-6'],
  down: ['M6 9l6 6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  server: ['M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M4 14h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z', 'M7 6.5h.01', 'M7 17.5h.01'],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36L21 8', 'M21 3v5h-5'],
  send: ['M12 19V5', 'M5 12l7-7 7 7'],
  stop: ['M7 7h10v10H7z'],
  check: ['M20 6L9 17l-5-5'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  help: ['M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  pencil: ['M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.35-4.35'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 18, color, strokeWidth = 1.8 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const c = usePalette();
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? c.muted} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    {name === 'help' ? <Circle cx={12} cy={12} r={10} /> : null}
    {paths[name].map(d => <Path key={d} d={d} />)}
  </Svg>;
}

type AccessiblePressableProps = PressableProps & { onKeyDown?: (event: any) => void };
/** Adds an explicit Enter fallback while retaining Pressable's native pointer, Space and focus behavior. */
export const AccessiblePressable = React.forwardRef<View, AccessiblePressableProps>(function AccessiblePressable(props, ref) {
  const enterHandled = React.useRef(false);
  const { onKeyDown, ...pressableProps } = props;
  return <Pressable {...(pressableProps as PressableProps)} ref={ref}
    onPressIn={event => { enterHandled.current = false; props.onPressIn?.(event); }}
    {...({ onKeyDown: (event: any) => {
      onKeyDown?.(event);
      const key = event.nativeEvent?.key ?? event.key;
      if (Platform.OS === 'web' && !props.disabled && !enterHandled.current && !event.defaultPrevented && key === 'Enter' && !event.nativeEvent?.altKey && !event.nativeEvent?.ctrlKey && !event.nativeEvent?.metaKey && !event.nativeEvent?.shiftKey) {
        event.preventDefault(); enterHandled.current = true; props.onPress?.(event);
      }
    } } as any)}
    onPress={event => {
      if (enterHandled.current) { enterHandled.current = false; return; }
      props.onPress?.(event);
    }}
  />;
});

export function Button({ label, onPress, variant = 'primary', size = 'md', icon, loading = false, disabled = false, accessibilityHint, testID, nativeID, style }: {
  label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; icon?: IconName; loading?: boolean; disabled?: boolean; accessibilityHint?: string; testID?: string; nativeID?: string; style?: StyleProp<ViewStyle>;
}) {
  const c = usePalette(); const s = useStyles();
  const fg = variant === 'primary' ? c.accentText : variant === 'danger' ? c.danger : c.text;
  const inactive = disabled || loading;
  return <AccessiblePressable nativeID={nativeID} testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: inactive, busy: loading }} disabled={inactive} onPress={onPress}
    style={({ pressed }) => [s.button, size === 'sm' && s.buttonSm, variant === 'primary' ? s.primary : variant === 'secondary' ? s.secondary : variant === 'danger' ? s.dangerButton : s.ghost, inactive && s.disabled, pressed && s.pressed, style]}>
    {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} color={fg} /> : null}
    <Text style={[s.buttonText, size === 'sm' && s.buttonTextSm, { color: fg }]}>{label}</Text>
  </AccessiblePressable>;
}

export function IconButton({ icon, label, onPress, testID, disabled, tone }: { icon: IconName; label: string; onPress: () => void; testID?: string; disabled?: boolean; tone?: 'accent' }) {
  const c = usePalette(); const s = useStyles();
  return <AccessiblePressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={6}
    style={({ pressed }) => [s.iconButton, tone === 'accent' && { backgroundColor: c.accent }, disabled && s.disabled, pressed && s.pressed]}>
    <Icon name={icon} size={20} color={tone === 'accent' ? c.accentText : c.text} />
  </AccessiblePressable>;
}

export function StatusDot({ tone, size = 8 }: { tone: Tone; size?: number }) {
  const c = usePalette();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor(c, tone) }} />;
}

/** Quiet status label: coloured dot + sentence-case text. Never colour alone. */
export function Status({ tone, label }: { tone: Tone; label: string }) {
  const c = usePalette(); const s = useStyles();
  return <View style={s.status}><StatusDot tone={tone} /><Text style={[s.statusText, { color: tone === 'neutral' ? c.muted : toneColor(c, tone) }]}>{label}</Text></View>;
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: Tone }) {
  const c = usePalette(); const s = useStyles();
  return <View style={[s.badge, { backgroundColor: toneSoft(c, tone) }]}><Text style={[s.badgeText, { color: tone === 'neutral' ? c.muted : toneColor(c, tone) }]}>{text}</Text></View>;
}

/** Page header. `title` receives initial focus on web for screen-reader orientation. */
export function Header({ title, eyebrow, onBack, right }: { title: string; eyebrow?: string; onBack?: () => void; right?: React.ReactNode }) {
  const s = useStyles();
  return <View style={s.header}>
    {onBack ? <IconButton icon="back" label="Back" onPress={onBack} /> : null}
    <View style={{ flex: 1, minWidth: 0 }}>
      {eyebrow ? <Text numberOfLines={1} style={s.eyebrow}>{eyebrow}</Text> : null}
      <Text nativeID="page-title" {...({ tabIndex: -1 } as Record<string, unknown>)} accessibilityRole="header" accessible numberOfLines={2} style={onBack ? s.headerTitleSm : s.headerTitle}>{title}</Text>
    </View>
    {right}
  </View>;
}

export function SectionTitle({ title, trailing }: { title: string; trailing?: React.ReactNode }) {
  const s = useStyles();
  return <View style={s.section}><Text accessibilityRole="header" {...({ 'aria-level': 2 } as Record<string, unknown>)} style={s.sectionTitle}>{title}</Text>{typeof trailing === 'string' ? <Text style={s.sectionTrailing}>{trailing}</Text> : trailing}</View>;
}

/** Grouped container; children are separated by hairlines. */
export function Group({ children, style, testID }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; testID?: string }>) {
  const s = useStyles();
  const items = React.Children.toArray(children).filter(Boolean);
  return <View testID={testID} style={[s.group, style]}>{items.map((child, index) => <React.Fragment key={index}>{index > 0 ? <View style={s.divider} /> : null}{child}</React.Fragment>)}</View>;
}

export function Card({ children, style, testID }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; testID?: string }>) {
  const s = useStyles();
  return <View testID={testID} style={[s.card, style]}>{children}</View>;
}

export function Notice({ tone = 'neutral', title, children, action }: PropsWithChildren<{ tone?: Tone; title?: string; action?: React.ReactNode }>) {
  const c = usePalette(); const s = useStyles();
  const alert = tone === 'danger';
  return <View accessibilityRole={alert ? 'alert' : undefined} {...webOnly(alert ? {} : { role: 'status', 'aria-live': 'polite' })} style={[s.notice, { backgroundColor: toneSoft(c, tone) }]}>
    <View style={{ paddingTop: 2 }}><Icon name={tone === 'neutral' || tone === 'success' ? (tone === 'success' ? 'check' : 'help') : 'alert'} size={15} color={tone === 'neutral' ? c.muted : toneColor(c, tone)} /></View>
    <View style={{ flex: 1, gap: 2 }}>
      {title ? <Text style={s.noticeTitle}>{title}</Text> : null}
      {children ? <Text style={s.noticeText}>{children}</Text> : null}
      {action ? <View style={{ marginTop: space.sm, alignItems: 'flex-start' }}>{action}</View> : null}
    </View>
  </View>;
}

export function Segmented<K extends string>({ options, value, onChange, testIDPrefix }: { options: ReadonlyArray<readonly [K, string, number?]>; value: K; onChange: (key: K) => void; testIDPrefix?: string }) {
  const s = useStyles();
  return <View style={s.segmented} accessibilityRole="tablist">
    {options.map(([key, label, count]) => {
      const selected = key === value;
      return <AccessiblePressable key={key} testID={testIDPrefix ? `${testIDPrefix}_${key}` : undefined} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={`${label}${count ? `, ${count}` : ''}`} onPress={() => onChange(key)} style={[s.segment, selected && s.segmentSelected]}>
        <Text style={[s.segmentText, selected && s.segmentTextSelected]}>{label}{count ? <Text style={s.segmentCount}>{`  ${count}`}</Text> : null}</Text>
      </AccessiblePressable>;
    })}
  </View>;
}

export const TextField = React.forwardRef<TextInput, TextInputProps & { label: string; optional?: boolean; error?: string; hint?: string; errorId?: string }>(function TextField({ label, optional, error, hint, errorId, style, ...input }, ref) {
  const c = usePalette(); const s = useStyles(); const [focused, setFocused] = useState(false);
  return <View style={{ gap: 6 }}>
    <Text style={s.fieldLabel}>{label}{optional ? <Text style={{ color: c.faint, fontWeight: '400' }}>  Optional</Text> : null}</Text>
    <TextInput ref={ref} accessibilityLabel={label} accessibilityHint={error} placeholderTextColor={c.faint} {...input}
      onFocus={event => { setFocused(true); input.onFocus?.(event); }} onBlur={event => { setFocused(false); input.onBlur?.(event); }}
      style={[s.input, focused && { borderColor: c.borderStrong }, !!error && { borderColor: c.danger }, style]}
      {...({ 'aria-invalid': !!error, 'aria-describedby': error && errorId ? errorId : undefined } as Record<string, unknown>)} />
    {error ? <Text nativeID={errorId} style={s.fieldError}>{error}</Text> : hint ? <Text style={s.fieldHint}>{hint}</Text> : null}
  </View>;
});

/** Minimal switch. `label` is the accessible name; render any visible label next to it. */
export function Toggle({ value, onValueChange, label, disabled = false, testID }: { value: boolean; onValueChange: (next: boolean) => void; label: string; disabled?: boolean; testID?: string }) {
  const s = useStyles();
  return <AccessiblePressable testID={testID} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} {...webOnly({ 'aria-checked': value })} disabled={disabled} hitSlop={8} onPress={() => onValueChange(!value)}
    style={({ pressed }) => [s.toggle, value && s.toggleOn, disabled && s.disabled, pressed && s.pressed]}>
    <View style={[s.knob, value && s.knobOn]} />
  </AccessiblePressable>;
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: React.ReactNode }) {
  const c = usePalette(); const s = useStyles();
  return <View style={s.empty}>
    <View style={s.emptyIcon}><Icon name={icon} size={22} color={c.muted} /></View>
    <Text style={s.emptyTitle}>{title}</Text>
    <Text style={s.emptyBody}>{body}</Text>
    {action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}
  </View>;
}

const useStyles = makeStyles(c => ({
  button: { minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  buttonSm: { minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.sm + 2 },
  primary: { backgroundColor: c.accent },
  secondary: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  ghost: { backgroundColor: 'transparent' },
  dangerButton: { backgroundColor: c.dangerSoft },
  buttonText: { fontSize: 15, fontWeight: '600' },
  buttonTextSm: { fontSize: 13 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  iconButton: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { ...type.caption, fontWeight: '500' },
  badge: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  badgeText: { ...type.caption, fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 48 },
  eyebrow: { ...type.caption, color: c.faint, marginBottom: 2 },
  headerTitle: { ...type.title, color: c.text, ...webOnly({ outlineStyle: 'none' }) },
  headerTitleSm: { ...type.heading, color: c.text, ...webOnly({ outlineStyle: 'none' }) },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xl, marginBottom: space.sm, paddingHorizontal: 2 },
  sectionTitle: { ...type.small, fontWeight: '600', color: c.muted },
  sectionTrailing: { ...type.caption, color: c.faint },
  group: { backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  divider: { height: 1, backgroundColor: c.border, marginLeft: space.lg },
  card: { backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: space.lg },
  notice: { flexDirection: 'row', gap: 10, padding: space.md, borderRadius: radius.md },
  noticeTitle: { ...type.small, fontWeight: '600', color: c.text },
  noticeText: { ...type.small, color: c.muted },
  segmented: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: 3 },
  segment: { flex: 1, minHeight: 34, borderRadius: radius.sm + 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
  segmentSelected: { backgroundColor: c.scheme === 'dark' ? c.borderStrong : c.bg, ...(c.scheme === 'light' ? { boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } : {}) },
  segmentText: { ...type.small, fontWeight: '500', color: c.muted },
  segmentTextSelected: { color: c.text, fontWeight: '600' },
  segmentCount: { color: c.faint, fontWeight: '500' },
  fieldLabel: { ...type.small, fontWeight: '500', color: c.text },
  input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: space.md, color: c.text, backgroundColor: c.bg, fontSize: Platform.OS === 'web' ? 16 : 15, ...webOnly({ outlineStyle: 'none' }) },
  fieldError: { ...type.caption, color: c.danger },
  fieldHint: { ...type.caption, color: c.faint },
  toggle: { width: 38, height: 22, borderRadius: radius.pill, padding: 2, backgroundColor: c.borderStrong, justifyContent: 'center' },
  toggleOn: { backgroundColor: c.accent },
  knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: c.bg },
  knobOn: { backgroundColor: c.accentText, transform: [{ translateX: 16 }] },
  empty: { alignItems: 'center', paddingVertical: 56, paddingHorizontal: space.xl },
  emptyIcon: { width: 48, height: 48, borderRadius: radius.lg, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
  emptyTitle: { ...type.heading, color: c.text, textAlign: 'center' },
  emptyBody: { ...type.small, color: c.muted, textAlign: 'center', marginTop: 6, maxWidth: 300 },
}));
