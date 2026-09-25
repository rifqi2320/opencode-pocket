export type FormAnswerValue = string | number | boolean | string[];
export type FormAnswers = Record<string, FormAnswerValue>;
export type FormOption = { value: string; label: string; description?: string };
type BaseField = { key: string; title: string; description?: string; required: boolean; when?: { key: string; op: 'eq' | 'neq'; value: string | number | boolean } };
export type SupportedField =
  | (BaseField & { type: 'text'; default?: string; placeholder?: string; minLength?: number; maxLength?: number; pattern?: RegExp; options?: FormOption[]; custom?: boolean })
  | (BaseField & { type: 'number'; minimum?: number; maximum?: number; default?: number })
  | (BaseField & { type: 'integer'; minimum?: number; maximum?: number; default?: number })
  | (BaseField & { type: 'boolean'; default?: boolean })
  | (BaseField & { type: 'multiselect'; options: FormOption[]; minItems?: number; maxItems?: number; default?: string[] });
export type ParsedForm = { supported: true; fields: SupportedField[] } | { supported: false; reason: string };

/** Parse only the pinned basic form schema. Unknown/ambiguous fields remain visible but cannot be submitted. */
export function parseFormFields(input: unknown): ParsedForm {
  if (!Array.isArray(input) || !input.length) return { supported: false, reason: 'This form has no supported fields.' };
  const fields: SupportedField[] = [];
  const keys = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.key !== 'string' || !raw.key.trim() || keys.has(raw.key)) return { supported: false, reason: 'A field has a missing or duplicate key.' };
    const key = raw.key;
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : key;
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    if (raw.required !== undefined && typeof raw.required !== 'boolean') return { supported: false, reason: `Field “${title}” has unsupported required metadata.` };
    let when: BaseField['when'];
    if (raw.when !== undefined) {
      if (!Array.isArray(raw.when) || raw.when.length > 1) return { supported: false, reason: `Field “${title}” has multiple or malformed conditions; answer it in OpenCode.` };
      const condition = raw.when[0];
      if (raw.when.length === 0) { /* An empty when list is equivalent to no condition. */ }
      else {
      if (!isRecord(condition) || typeof condition.key !== 'string' || !keys.has(condition.key) || (condition.op !== 'eq' && condition.op !== 'neq') || !isScalar(condition.value)) {
        return { supported: false, reason: `Field “${title}” has a condition this app cannot safely evaluate.` };
      }
      when = { key: condition.key, op: condition.op, value: condition.value };
      }
    }
    const base = { key, title, required: raw.required === true, ...(description !== undefined ? { description } : {}), ...(when ? { when } : {}) };
    if (raw.type === 'external') return { supported: false, reason: `Field “${title}” requires an external interaction. Continue in OpenCode.` };
    if (raw.type === 'string') {
      const options = raw.options === undefined ? undefined : parseOptions(raw.options);
      if (raw.options !== undefined && (!options || !options.length)) return { supported: false, reason: `Field “${title}” has unsupported selection options.` };
      if (raw.custom !== undefined && typeof raw.custom !== 'boolean') return { supported: false, reason: `Field “${title}” has unsupported custom-value settings.` };
      const minLength = optionalCount(raw.minLength); const maxLength = optionalCount(raw.maxLength);
      if ((raw.minLength !== undefined && minLength === undefined) || (raw.maxLength !== undefined && maxLength === undefined) || (minLength !== undefined && maxLength !== undefined && minLength > maxLength)) return { supported: false, reason: `Field “${title}” has invalid text-length limits.` };
      let pattern: RegExp | undefined;
      if (raw.pattern !== undefined) { if (typeof raw.pattern !== 'string' || raw.pattern.length > 512) return { supported: false, reason: `Field “${title}” has an unsupported validation pattern.` }; try { pattern = new RegExp(raw.pattern); } catch { return { supported: false, reason: `Field “${title}” has an invalid validation pattern.` }; } }
      const defaultValue = typeof raw.default === 'string' ? raw.default : undefined;
      fields.push({ ...base, type: 'text', ...(defaultValue !== undefined ? { default: defaultValue } : {}), ...(typeof raw.placeholder === 'string' ? { placeholder: raw.placeholder } : {}), ...(minLength !== undefined ? { minLength } : {}), ...(maxLength !== undefined ? { maxLength } : {}), ...(pattern ? { pattern } : {}), ...(options ? { options } : {}), ...(raw.custom === true ? { custom: true } : {}) });
    } else if (raw.type === 'number' || raw.type === 'integer') {
      const minimum = finiteNumber(raw.minimum); const maximum = finiteNumber(raw.maximum); const defaultValue = finiteNumber(raw.default);
      if ((raw.minimum !== undefined && minimum === undefined && typeof raw.minimum === 'number') || (raw.maximum !== undefined && maximum === undefined && typeof raw.maximum === 'number') || (minimum !== undefined && maximum !== undefined && minimum > maximum)) return { supported: false, reason: `Field “${title}” has an invalid numeric range.` };
      fields.push({ ...base, type: raw.type, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}), ...(defaultValue !== undefined ? { default: defaultValue } : {}) });
    } else if (raw.type === 'boolean') {
      fields.push({ ...base, type: 'boolean', ...(typeof raw.default === 'boolean' ? { default: raw.default } : {}) });
    } else if (raw.type === 'multiselect') {
      const options = parseOptions(raw.options);
      if (!options?.length || raw.custom === true) return { supported: false, reason: `Field “${title}” has unsupported multi-select options.` };
      const minItems = optionalCount(raw.minItems); const maxItems = optionalCount(raw.maxItems);
      if ((raw.minItems !== undefined && minItems === undefined) || (raw.maxItems !== undefined && maxItems === undefined) || (minItems !== undefined && maxItems !== undefined && minItems > maxItems)) return { supported: false, reason: `Field “${title}” has invalid selection limits.` };
      const defaultValue = Array.isArray(raw.default) && raw.default.every(value => typeof value === 'string') ? raw.default as string[] : undefined;
      fields.push({ ...base, type: 'multiselect', options, ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}), ...(defaultValue ? { default: defaultValue } : {}) });
    } else return { supported: false, reason: `Field “${title}” uses an unsupported type. Continue in OpenCode.` };
    keys.add(key);
  }
  return { supported: true, fields };
}

export function visibleFields(fields: SupportedField[], answers: FormAnswers) {
  const visible: SupportedField[] = [];
  const effectiveAnswers: FormAnswers = {};
  for (const field of fields) {
    if (field.when) {
      const actual = effectiveAnswers[field.when.key];
      if (actual === undefined) continue;
      const equal = Array.isArray(actual) ? actual.includes(String(field.when.value)) : actual === field.when.value;
      if (field.when.op === 'eq' ? !equal : equal) continue;
    }
    visible.push(field);
    const answer = answers[field.key]; if (answer !== undefined) effectiveAnswers[field.key] = answer;
  }
  return visible;
}

export function validateAnswers(fields: SupportedField[], answers: FormAnswers) {
  const errors: Record<string, string> = {};
  const visible = visibleFields(fields, answers);
  for (const field of visible) {
    const value = answers[field.key];
    if (field.type === 'boolean') { if (field.required && typeof value !== 'boolean') errors[field.key] = 'Choose yes or no.'; continue; }
    if (field.type === 'multiselect') {
      const values = Array.isArray(value) ? value : [];
      if (field.required && values.length === 0) errors[field.key] = 'Select at least one option.';
      else if (field.minItems !== undefined && values.length < field.minItems) errors[field.key] = `Select at least ${field.minItems}.`;
      else if (field.maxItems !== undefined && values.length > field.maxItems) errors[field.key] = `Select no more than ${field.maxItems}.`;
      else if (values.some(item => !field.options.some(option => option.value === item))) errors[field.key] = 'Choose only listed options.';
      continue;
    }
    if (field.type === 'number' || field.type === 'integer') {
      if (value === undefined || value === '') { if (field.required) errors[field.key] = 'This field is required.'; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value)) errors[field.key] = 'Enter a finite number.';
      else if (field.type === 'integer' && !Number.isInteger(value)) errors[field.key] = 'Enter a whole number.';
      else if (field.minimum !== undefined && value < field.minimum) errors[field.key] = `Enter at least ${field.minimum}.`;
      else if (field.maximum !== undefined && value > field.maximum) errors[field.key] = `Enter no more than ${field.maximum}.`;
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (field.required && !text.trim()) errors[field.key] = 'This field is required.';
    else if (text && field.minLength !== undefined && text.length < field.minLength) errors[field.key] = `Use at least ${field.minLength} characters.`;
    else if (text && field.maxLength !== undefined && text.length > field.maxLength) errors[field.key] = `Use no more than ${field.maxLength} characters.`;
    else if (text && field.pattern && !field.pattern.test(text)) errors[field.key] = 'The answer does not match the required format.';
    else if (text && field.options && !field.custom && !field.options.some(option => option.value === text)) errors[field.key] = 'Choose one of the listed options.';
  }
  const visibleKeys = new Set(visible.map(field => field.key));
  const payload: FormAnswers = {};
  for (const field of visible) {
    const value = answers[field.key];
    if (value === undefined || (typeof value === 'string' && !value.trim() && !field.required)) continue;
    if (field.type === 'multiselect' && Array.isArray(value) && value.length === 0 && !field.required && field.minItems === undefined) continue;
    if (visibleKeys.has(field.key)) payload[field.key] = value;
  }
  return { errors, payload, valid: Object.keys(errors).length === 0 };
}

function parseOptions(input: unknown): FormOption[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const options: FormOption[] = [];
  const values = new Set<string>();
  for (const item of input) {
    if (!isRecord(item) || typeof item.value !== 'string' || typeof item.label !== 'string' || values.has(item.value)) return undefined;
    values.add(item.value); options.push({ value: item.value, label: item.label, ...(typeof item.description === 'string' ? { description: item.description } : {}) });
  }
  return options;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isScalar(value: unknown): value is string | number | boolean { return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)); }
function finiteNumber(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function optionalCount(value: unknown) { return Number.isInteger(value) && typeof value === 'number' && value >= 0 ? value : undefined; }
