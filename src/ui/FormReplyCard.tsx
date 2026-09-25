import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { AccessiblePressable, Button, Card, Icon, Notice, TextField } from './components';
import { makeStyles, radius, space, type, usePalette } from './theme';
import { parseFormFields, validateAnswers, visibleFields, type FormAnswerValue, type FormAnswers, type SupportedField } from './forms';
import type { PocketFormRequest } from './types';

type Resolution = 'answered' | 'cancelled' | 'pending' | 'unknown';
const live = { accessibilityLiveRegion: 'polite', role: 'status', 'aria-live': 'polite' } as Record<string, unknown>;

export function FormReplyCard({ form, onSubmit }: { form: PocketFormRequest; onSubmit: (formId: string, answers: FormAnswers) => Promise<Resolution> }) {
  const c = usePalette(); const s = useStyles();
  const parsed = useMemo(() => parseFormFields(form.fields), [form.fields]);
  const [answers, setAnswers] = useState<FormAnswers>(() => parsed.supported ? initialAnswers(parsed.fields) : {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const controlRefs = React.useRef<Record<string, { focus?: () => void } | null>>({});
  const visible = parsed.supported ? visibleFields(parsed.fields, answers) : [];

  const update = (key: string, value: FormAnswerValue | undefined) => {
    setAnswers(previous => { const next = { ...previous }; if (value === undefined) delete next[key]; else next[key] = value; return next; });
    setErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    setMessage(''); setError('');
  };

  const submit = async () => {
    if (!parsed.supported || busy) return;
    const result = validateAnswers(parsed.fields, answers);
    setErrors(result.errors); setMessage(''); setError('');
    if (!result.valid) {
      const firstInvalid = visible.find(field => result.errors[field.key]);
      if (firstInvalid) requestAnimationFrame(() => controlRefs.current[firstInvalid.key]?.focus?.());
      return;
    }
    // Destination is captured by the parent callback before its first await; there is no local retry.
    setBusy(true);
    try {
      const resolution = await onSubmit(form.id, result.payload);
      setMessage(resolution === 'answered' ? 'Answered.' : resolution === 'cancelled' ? 'Resolved elsewhere (cancelled).' : resolution === 'pending' ? 'Acknowledged, but still pending. Check before resending.' : 'Acknowledged; final state unconfirmed. Not resent.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reply could not be confirmed. Refresh before acting again.');
    } finally { setBusy(false); }
  };

  return <Card style={s.card}>
    <View style={s.head}><Icon name="help" size={16} color={c.warning} /><Text style={s.title}>{form.title}</Text></View>
    {!parsed.supported ? <Notice tone="warning" title="Continue in OpenCode">{parsed.reason}</Notice> : <>
      {visible.map(field => <Field key={field.key} formId={form.id} field={field} value={answers[field.key]} error={errors[field.key]} registerFocus={node => { controlRefs.current[field.key] = node; }} onChange={value => update(field.key, value)} />)}
      <View style={s.footer}>
        <Text style={s.caption}>Only visible fields are sent. Rechecked before sending.</Text>
        <Button testID="question_submit" label="Submit answer" size="sm" loading={busy} onPress={() => void submit()} disabled={busy} />
      </View>
    </>}
    {message ? <Text {...live} style={s.success}>{message}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
  </Card>;
}

function Field({ formId, field, value, error, registerFocus, onChange }: { formId: string; field: SupportedField; value: FormAnswerValue | undefined; error?: string; registerFocus: (node: { focus?: () => void } | null) => void; onChange: (value: FormAnswerValue | undefined) => void }) {
  const c = usePalette(); const s = useStyles();
  const errorId = `form-field-error-${encodeURIComponent(formId)}-${encodeURIComponent(field.key)}`;
  const associate = { errorId: error ? errorId : undefined, error, focusRef: registerFocus };
  const isChoice = field.type === 'boolean' || field.type === 'multiselect' || (field.type === 'text' && !!field.options);

  if (!isChoice) return <TextField ref={registerFocus as any} label={field.title} optional={!field.required} hint={field.description} error={error} errorId={errorId}
    value={value === undefined ? '' : String(value)}
    onChangeText={text => { if (!text) onChange(undefined); else if (field.type === 'number' || field.type === 'integer') onChange(Number(text)); else onChange(text); }}
    placeholder={field.type === 'text' ? field.placeholder : undefined}
    keyboardType={field.type === 'number' || field.type === 'integer' ? 'decimal-pad' : 'default'} autoCapitalize="sentences" />;

  return <View style={{ gap: 6 }}>
    <Text style={s.fieldLabel}>{field.title}{!field.required ? <Text style={{ color: c.faint, fontWeight: '400' }}>  Optional</Text> : null}</Text>
    {field.description ? <Text style={s.caption}>{field.description}</Text> : null}
    {field.type === 'boolean' ? <View style={s.options}>{([true, false] as const).map((option, index) => <Option key={String(option)} fieldTitle={field.title} role="radio" label={option ? 'Yes' : 'No'} selected={value === option} onPress={() => onChange(option)} {...(index === 0 ? associate : {})} />)}</View>
      : field.type === 'multiselect' ? <View style={s.options}>{field.options.map((option, index) => {
        const selected = Array.isArray(value) && value.includes(option.value);
        return <Option key={option.value} fieldTitle={field.title} label={option.label} selected={selected} onPress={() => { const previous = Array.isArray(value) ? value : []; if (selected) onChange(previous.filter(item => item !== option.value)); else if (field.maxItems === undefined || previous.length < field.maxItems) onChange([...previous, option.value]); }} {...(index === 0 ? associate : {})} />;
      })}</View>
        : field.type === 'text' && field.options ? <>
          <View style={s.options}>{field.options.map((option, index) => <Option key={option.value} fieldTitle={field.title} role="radio" label={option.label} selected={value === option.value} onPress={() => onChange(option.value)} {...(index === 0 ? associate : {})} />)}</View>
          {field.custom ? <TextField ref={registerFocus as any} label="Custom value" optional accessibilityLabel={`${field.title} custom value`} accessibilityHint={error}
            value={typeof value === 'string' && !field.options.some(option => option.value === value) ? value : ''} onChangeText={text => onChange(text || undefined)} placeholder="Or enter your own"
            {...({ 'aria-invalid': !!error, 'aria-describedby': error ? errorId : undefined } as Record<string, unknown>)} /> : null}
        </> : null}
    {error ? <Text nativeID={errorId} style={s.error}>{error}</Text> : null}
  </View>;
}

function Option({ fieldTitle, label, selected, onPress, role = 'checkbox', error, errorId, focusRef }: { fieldTitle: string; label: string; selected: boolean; onPress: () => void; role?: 'checkbox' | 'radio'; error?: string; errorId?: string; focusRef?: (node: { focus?: () => void } | null) => void }) {
  const c = usePalette(); const s = useStyles();
  return <AccessiblePressable ref={focusRef as any} accessibilityRole={role} accessibilityLabel={`${fieldTitle}: ${label}`} accessibilityHint={error} accessibilityState={role === 'checkbox' ? { checked: selected } : { selected }} onPress={onPress}
    style={({ pressed }) => [s.option, selected && s.optionSelected, !!error && { borderColor: c.danger }, pressed && { opacity: 0.7 }]}
    {...({ 'aria-invalid': !!error, 'aria-describedby': error ? errorId : undefined } as Record<string, unknown>)}>
    {selected ? <Icon name="check" size={14} color={c.accentText} strokeWidth={2.2} /> : null}
    <Text style={[s.optionText, selected && { color: c.accentText }]}>{label}</Text>
  </AccessiblePressable>;
}

function initialAnswers(fields: SupportedField[]): FormAnswers {
  const answers: FormAnswers = {};
  for (const field of fields) if (field.default !== undefined) answers[field.key] = field.default;
  return answers;
}

const useStyles = makeStyles(c => ({
  card: { gap: space.lg, marginBottom: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...type.body, fontWeight: '600', color: c.text, flex: 1 },
  fieldLabel: { ...type.small, fontWeight: '500', color: c.text },
  caption: { ...type.caption, color: c.faint },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  option: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  optionSelected: { backgroundColor: c.accent, borderColor: c.accent },
  optionText: { ...type.small, fontWeight: '500', color: c.text },
  footer: { gap: space.sm, alignItems: 'flex-start' },
  success: { ...type.caption, color: c.success },
  error: { ...type.caption, color: c.danger },
}));
