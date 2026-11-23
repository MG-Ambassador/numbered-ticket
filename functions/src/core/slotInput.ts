// 枠の登録内容の検証と CSV の読み込み（A-04）。URL・SNS の ID を含む入力は拒否する。
import type { FacultyProfile, SlotRowError, StudentSlotInput } from '@nt/shared';

export const LIMITS = {
  nickname: 20,
  department: 40,
  bio: 200,
  tags: 5,
  tag: 15,
  location: 8,
  facultyTitle: 40,
  facultyFields: 10,
  facultyField: 20,
  facultyDescription: 400,
} as const;

/**
 * URL・SNS の ID らしいもの。全角は NFKC で半角にしてから調べる。
 * 例: https://… / www.… / example.com / @handle / 「インスタ: xxx」「LINE ID」
 */
export function containsContact(text: string): boolean {
  const t = text.normalize('NFKC');
  return (
    /(https?:|www\.)/i.test(t) ||
    /[a-z0-9-]+\.(com|net|org|jp|io|me|co|ly|app|link|page|dev|info|xyz|tv|gg)\b/i.test(t) ||
    /@[a-z0-9_.]{2,}/i.test(t) ||
    /(line|insta(gram)?|twitter|tiktok|discord|threads|facebook|インスタ|ツイッター|ライン|ティックトック)\s*(id|アカ(ウント)?)?\s*[:：=]/i.test(t) ||
    /(line|インスタ|twitter)\s*id/i.test(t)
  );
}

type Errors = SlotRowError[];

function text(errors: Errors, row: number, field: string, value: unknown, max: number, required: boolean): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (typeof value !== 'string' && value !== undefined && value !== null) errors.push({ row, field, message: '文字列で入力してください' });
  else if (required && v === '') errors.push({ row, field, message: '必須です' });
  else if ([...v].length > max) errors.push({ row, field, message: `${max}文字までです` });
  else if (containsContact(v)) errors.push({ row, field, message: 'URL や SNS の ID は登録できません' });
  return v;
}

export const SLOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 学生枠1件を検証して正規化する。誤りは errors に積む */
export function normalizeStudentSlot(input: StudentSlotInput, row: number, errors: Errors): StudentSlotInput {
  const id = input.id === undefined || input.id === '' ? undefined : String(input.id).trim();
  if (id !== undefined && (!SLOT_ID_PATTERN.test(id) || id === 'faculty')) errors.push({ row, field: 'id', message: 'ID は英数字・_・- で 64 文字までです' });
  const nickname = text(errors, row, 'nickname', input.nickname, LIMITS.nickname, true);
  const department = text(errors, row, 'department', input.department, LIMITS.department, false);
  const bio = text(errors, row, 'bio', input.bio, LIMITS.bio, false);
  const location = text(errors, row, 'location', input.location, LIMITS.location, false);
  const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => text(errors, row, 'tags', t, LIMITS.tag, false)).filter(Boolean);
  if (tags.length > LIMITS.tags) errors.push({ row, field: 'tags', message: `タグは ${LIMITS.tags} 個までです` });
  const order = Number(input.order);
  if (!Number.isInteger(order) || order < 0 || order > 999) errors.push({ row, field: 'order', message: '並び順は 0〜999 の整数です' });
  return {
    ...(id !== undefined ? { id } : {}),
    nickname,
    department,
    bio,
    tags: [...new Set(tags.map((t) => t.replace(/^#/, '')))],
    location: location === '' ? null : location,
    order,
  };
}

export function normalizeFacultyProfile(input: FacultyProfile, errors: Errors): FacultyProfile {
  const title = text(errors, 1, 'title', input?.title, LIMITS.facultyTitle, true);
  const description = text(errors, 1, 'description', input?.description, LIMITS.facultyDescription, false);
  const fields = (Array.isArray(input?.fields) ? input.fields : []).map((f) => text(errors, 1, 'fields', f, LIMITS.facultyField, false)).filter(Boolean);
  if (fields.length > LIMITS.facultyFields) errors.push({ row: 1, field: 'fields', message: `${LIMITS.facultyFields} 個までです` });
  return { title, description, fields };
}

/** RFC 4180 の CSV（ダブルクォート・改行入りの値に対応）。BOM は取り除く */
export function parseCsv(csv: string): string[][] {
  const src = csv.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** CSV の見出し。tags は空白・読点・セミコロンで区切る */
export const CSV_COLUMNS = ['id', 'nickname', 'department', 'bio', 'tags', 'location', 'order'] as const;
export const MAX_IMPORT_ROWS = 50;

export function csvToSlots(csv: string): { slots: StudentSlotInput[]; errors: Errors } {
  const errors: Errors = [];
  const rows = parseCsv(csv);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const missing = CSV_COLUMNS.filter((c) => c !== 'id' && !header.includes(c));
  if (missing.length > 0) return { slots: [], errors: [{ row: 0, field: missing.join(','), message: '見出しの列がありません' }] };
  if (rows.length === 0 || rows.length > MAX_IMPORT_ROWS) {
    return { slots: [], errors: [{ row: 0, field: '', message: `1〜${MAX_IMPORT_ROWS} 行にしてください` }] };
  }
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? (r[i] ?? '') : '';
  };
  const slots = rows.map((r, i) =>
    normalizeStudentSlot(
      {
        id: col(r, 'id'),
        nickname: col(r, 'nickname'),
        department: col(r, 'department'),
        bio: col(r, 'bio'),
        tags: col(r, 'tags').split(/[\s、,;；]+/).filter(Boolean),
        location: col(r, 'location'),
        order: col(r, 'order') === '' ? i : Number(col(r, 'order')),
      },
      i + 1,
      errors,
    ),
  );
  const ids = slots.map((s) => s.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push({ row: 0, field: 'id', message: 'ID が重複しています' });
  return { slots, errors };
}
