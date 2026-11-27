// P2 管理者の関数（A-01〜A-07）と、その部品（コード生成・CSV・統計）。
import { Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FACULTY_SLOT_ID,
  entryUrl,
  paths,
  storagePaths,
  type AdminRequest,
  type AuditLogDoc,
  type BoardDoc,
  type EventDoc,
  type EventSettings,
  type QueueDoc,
  type SecretCodesDoc,
  type SlotDoc,
  type StudentSlotDoc,
  type TicketDoc,
  type ViewCodesResponse,
} from '@nt/shared';
import { admin } from '../../../functions/src/core/admin.js';
import { generateCode, isGuessableCode } from '../../../functions/src/core/codes.js';
import { containsContact, csvToSlots, parseCsv } from '../../../functions/src/core/slotInput.js';
import * as staff from '../../../functions/src/core/staff.js';
import { buildStats } from '../../../functions/src/core/stats.js';
import * as visitor from '../../../functions/src/core/visitor.js';
import {
  ENTRY_CODE,
  FACULTY_CODE,
  SLOT_CODES,
  NOW,
  adminCaller,
  anonymous,
  auth,
  clearFirestore,
  db,
  expectReason,
  makeDeps,
  read,
  seedEvent,
  seedStaff,
  seedVisitors,
  staffCaller,
  visitorCaller,
} from './fixture.js';

const deps = makeDeps();
const ADMIN = adminCaller();
const call = <T = unknown>(req: AdminRequest, d = deps) => admin(d, ADMIN, req) as Promise<T>;

const SETTINGS: EventSettings = {
  title: '2027年3月 オープンキャンパス',
  opensAt: '2027-03-20T10:00:00+09:00',
  closesAt: '2027-03-20T16:00:00+09:00',
  consultMinutes: 10,
  skipReturnMinutes: 10,
  themes: ['入試', '授業', '学生生活'],
};

const CSV = `id,nickname,department,bio,tags,location,order
,みさき,心理学部 2年,"部活と勉強の両立、""留学""の話ができます",留学 部活,A-1,1
,けんた,経済学部 3年,,就職;資格,A-2,2
`;

async function logs(eid: string): Promise<AuditLogDoc[]> {
  return (await db.collection(paths.auditLog(eid)).get()).docs.map((d) => d.data() as AuditLogDoc);
}

beforeEach(async () => {
  await clearFirestore();
});

// ---------------------------------------------------------------------------

describe('A-01 管理者の認証', () => {
  it('admin クレーム＋パスワードのログインだけが呼べる（TOTP は不要）', async () => {
    await expectReason(admin(deps, { ...ADMIN, provider: 'anonymous' }, { op: 'dashboard', eid: 'e1' }), 'forbidden');
    await expectReason(admin(deps, { ...ADMIN, admin: false }, { op: 'dashboard', eid: 'e1' }), 'forbidden');
    await expectReason(admin(deps, visitorCaller('v'), { op: 'dashboard', eid: 'e1' }), 'forbidden');
    await expectReason(admin(deps, staffCaller('s', 'faculty'), { op: 'dashboard', eid: 'e1' }), 'forbidden');
    await expectReason(admin(deps, null, { op: 'dashboard', eid: 'e1' }), 'forbidden');
    // TOTP の有無にかかわらず呼べる
    await seedEvent();
    await call({ op: 'recordLogin', eid: 'e1' });
    await admin(deps, { ...ADMIN, secondFactor: 'totp' }, { op: 'recordLogin', eid: 'e1' });
  });

  it('ログインを auditLog に残す。知らない op は拒否', async () => {
    await seedEvent();
    await call({ op: 'recordLogin', eid: 'e1' });
    expect((await logs('e1')).map((l) => l.action)).toEqual(['admin.login']);
    await expectReason(call({ op: 'nope' } as never), 'invalidInput');
  });

  it('初回設定が終わると initial クレームが外れる（TOTP は不要）', async () => {
    const uid = `adm-${Date.now()}`;
    await auth.createUser({ uid, email: `${uid}@example.com`, password: 'abcdefghijklmn', emailVerified: true });
    await auth.setCustomUserClaims(uid, { admin: true, initial: true });
    await admin(deps, adminCaller(uid), { op: 'completeSetup' });
    expect((await auth.getUser(uid)).customClaims).toEqual({ admin: true });
  });
});

// ---------------------------------------------------------------------------

describe('A-02 イベント設定・A-03 コード', () => {
  it('イベントを作ると、コード・教員相談の枠・board・auditLog がそろう', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    const event = await read<EventDoc>(paths.event(eid));
    expect(event).toMatchObject({ state: 'scheduled', nextTicketNumber: 101, paused: false, themes: SETTINGS.themes });
    expect(event.opensAt.toMillis()).toBe(Date.parse(SETTINGS.opensAt));

    const codes = await read<SecretCodesDoc>(paths.secretCodes(eid));
    expect(codes.entryCode).toMatch(/^\d{7}$/);
    expect(codes.facultyCode).toMatch(/^\d{8}$/);
    expect(codes.slotCodes).toEqual({});
    expect(isGuessableCode(codes.entryCode) || isGuessableCode(codes.facultyCode)).toBe(false);

    expect((await read<SlotDoc>(paths.slot(eid, FACULTY_SLOT_ID))).kind).toBe('faculty');
    expect((await read<BoardDoc>(paths.board(eid))).slots[FACULTY_SLOT_ID]).toMatchObject({ status: 'preparing' });
    expect((await logs(eid)).map((l) => l.action)).toEqual(['event.create']);
  });

  it('設定の検証: 時刻の前後、相談時間の範囲、テーマの重複、URL', async () => {
    const bad: Partial<EventSettings>[] = [
      { closesAt: SETTINGS.opensAt },
      { opensAt: 'あした' },
      { consultMinutes: 0 },
      { skipReturnMinutes: 1.5 },
      { themes: [] },
      { themes: ['入試', '入試'] },
      { title: '' },
      // 開催が24時間を超える（年の入力違い。2026-11-26 の試用で実際に起きた）
      { opensAt: '2026-03-20T10:00:00+09:00' },
      // 閉場がもう過ぎている（NOW は 2027-03-20 11:00 JST）
      { opensAt: '2027-03-20T09:00:00+09:00', closesAt: '2027-03-20T10:30:00+09:00' },
    ];
    for (const b of bad) await expectReason(call({ op: 'createEvent', settings: { ...SETTINGS, ...b } }), 'invalidInput');
    await expectReason(call({ op: 'createEvent', settings: { ...SETTINGS, themes: ['詳しくは example.com'] } }), 'containsContact');
  });

  it('相談時間を変えると board の目安時間の材料も変わる。閉場後は変えられない', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    await call({ op: 'updateEvent', eid, settings: { consultMinutes: 15 } });
    expect((await read<EventDoc>(paths.event(eid))).consultMinutes).toBe(15);
    expect((await read<BoardDoc>(paths.board(eid))).slots[FACULTY_SLOT_ID]!.avgConsultSeconds).toBe(900);
    expect((await logs(eid)).find((l) => l.action === 'event.update')?.detail).toEqual({ fields: 'consultMinutes' });

    await db.doc(paths.event(eid)).update({ state: 'closed' });
    await expectReason(call({ op: 'updateEvent', eid, settings: { consultMinutes: 10 } }), 'invalidState');
  });

  it('開場中に開場時刻を未来へ変えると開場前に戻る。入場した方がいれば断る', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    await db.doc(paths.event(eid)).update({ state: 'open' });
    await call({ op: 'updateEvent', eid, settings: { opensAt: '2027-03-20T13:00:00+09:00' } });
    expect((await read<EventDoc>(paths.event(eid))).state).toBe('scheduled');
    expect((await logs(eid)).find((l) => l.action === 'event.update')?.detail).toEqual({ fields: 'opensAt', state: 'scheduled' });

    // 開場時刻が過ぎたままの変更では戻さない
    await db.doc(paths.event(eid)).update({ state: 'open' });
    await call({ op: 'updateEvent', eid, settings: { opensAt: '2027-03-20T10:30:00+09:00' } });
    expect((await read<EventDoc>(paths.event(eid))).state).toBe('open');

    await db.doc(`events/${eid}/visitors/u1`).set({ enteredAt: Timestamp.fromDate(NOW) });
    await expectReason(call({ op: 'updateEvent', eid, settings: { opensAt: '2027-03-20T13:00:00+09:00' } }), 'eventStarted');
    expect((await read<EventDoc>(paths.event(eid))).state).toBe('open');
  });

  it('閉場を過去に変えることはできない（早く閉じるときは閉場の操作）', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    await expectReason(call({ op: 'updateEvent', eid, settings: { closesAt: '2027-03-20T10:30:00+09:00' } }), 'invalidInput');
  });

  it('コードの表示と再発行を auditLog に残す。再発行後は古い入場コードで入れない', async () => {
    await seedEvent();
    const shown = await call<ViewCodesResponse>({ op: 'viewCodes', eid: 'e1' });
    expect(shown.entryCode).toBe(ENTRY_CODE);
    expect(shown.facultyCode).toBe(FACULTY_CODE);
    expect(shown.slotCodes).toEqual([{ slotId: 's1', label: 'A-1 学生0', code: SLOT_CODES.s1 }]);

    const next = await call<ViewCodesResponse>({ op: 'reissueCode', eid: 'e1', kind: 'entry' });
    expect(next.entryCode).not.toBe(ENTRY_CODE);
    expect(next.facultyCode).toBe(shown.facultyCode);
    expect(next.slotCodes).toEqual(shown.slotCodes);
    expect((await logs('e1')).map((l) => [l.action, l.detail.kind ?? null]).sort()).toEqual([
      ['code.reissue', 'entry'],
      ['code.view', null],
    ]);

    const uid = `v-new-${Date.now()}`;
    await auth.createUser({ uid });
    await expectReason(visitor.enterEvent(deps, anonymous(uid), { code: ENTRY_CODE }), 'wrongCode');
    await expect(visitor.enterEvent(deps, anonymous(uid), { code: next.entryCode })).resolves.toMatchObject({ eid: 'e1' });
    expect(entryUrl('https://oc.example.ac.jp/', next.entryCode)).toBe(`https://oc.example.ac.jp/#code=${next.entryCode}`);
  });

  it('推測されやすいコードを判定する', () => {
    for (const c of ['0000000', '1234567', '9876543', '7890123', '1212121', '1231231', '12341234', '1111234', '20270320', '1122112']) {
      expect(isGuessableCode(c), c).toBe(true);
    }
    for (const c of ['0384712', '03847125', '5190386', '73019428']) expect(isGuessableCode(c), c).toBe(false);
    for (let i = 0; i < 500; i++) {
      const e = generateCode(7);
      const s = generateCode(8, [e]);
      expect(isGuessableCode(e) || isGuessableCode(s) || e.slice(0, 4) === s.slice(0, 4)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('A-04 枠の登録', () => {
  it('CSV から学生枠と列を作り、board に準備中で載せる', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    const { slotIds } = await call<{ slotIds: string[] }>({ op: 'importSlots', eid, csv: CSV });
    expect(slotIds).toHaveLength(2);

    const first = await read<StudentSlotDoc>(paths.slot(eid, slotIds[0]!));
    expect(first).toMatchObject({
      kind: 'student',
      order: 1,
      location: 'A-1',
      queueLimit: 5,
      occupant: null,
      profile: { nickname: 'みさき', bio: '部活と勉強の両立、"留学"の話ができます', tags: ['留学', '部活'], avatarPath: null },
    });
    expect((await read<StudentSlotDoc>(paths.slot(eid, slotIds[1]!))).profile.tags).toEqual(['就職', '資格']);
    expect((await read<QueueDoc>(paths.queue(eid, slotIds[0]!))).waiting).toEqual([]);
    const board = await read<BoardDoc>(paths.board(eid));
    expect(Object.keys(board.slots).sort()).toEqual([FACULTY_SLOT_ID, ...slotIds].sort());
    expect(board.slots[slotIds[0]!]!.status).toBe('preparing');
    expect((await logs(eid)).find((l) => l.action === 'slot.import')?.detail).toEqual({ count: 2 });

    // 枠ごとに別のスタッフコードができる。先頭4桁はどのコードとも重ならない
    const codes = await read<SecretCodesDoc>(paths.secretCodes(eid));
    expect(Object.keys(codes.slotCodes).sort()).toEqual([...slotIds].sort());
    const all = [codes.entryCode, codes.facultyCode, ...Object.values(codes.slotCodes)];
    expect(new Set(all.map((c) => c.slice(0, 4))).size).toBe(all.length);
    expect(Object.values(codes.slotCodes).every((c) => /^\d{8}$/.test(c) && !isGuessableCode(c))).toBe(true);

    // 同じ枠を直しても、コードは変わらない
    await call({ op: 'importSlots', eid, csv: `id,nickname,department,bio,tags,location,order\n${slotIds[0]},みさき2,,,,A-1,1\n` });
    expect((await read<SecretCodesDoc>(paths.secretCodes(eid))).slotCodes).toEqual(codes.slotCodes);
  });

  it('枠のスタッフコードは枠ごとに作り直せる。ほかのコードは変わらない', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2', occupied: false }] });
    const next = await call<ViewCodesResponse>({ op: 'reissueCode', eid: 'e1', kind: 'slot', slotId: 's2' });
    expect(next.slotCodes.find((c) => c.slotId === 's2')!.code).not.toBe(SLOT_CODES.s2);
    expect(next.slotCodes.find((c) => c.slotId === 's1')!.code).toBe(SLOT_CODES.s1);
    expect([next.entryCode, next.facultyCode]).toEqual([ENTRY_CODE, FACULTY_CODE]);
    expect((await logs('e1')).find((l) => l.action === 'code.reissue')).toMatchObject({ target: 's2', detail: { kind: 'slot' } });

    await expectReason(call({ op: 'reissueCode', eid: 'e1', kind: 'slot', slotId: FACULTY_SLOT_ID }), 'invalidInput');
    await expectReason(call({ op: 'reissueCode', eid: 'e1', kind: 'slot' }), 'invalidInput');
    await expectReason(call({ op: 'reissueCode', eid: 'e1', kind: 'staff' as never }), 'invalidInput');
    // 古いコードでは入れない
    await expectReason(staff.staffLogin(deps, anonymous('st-old'), { code: SLOT_CODES.s2! }), 'wrongCode');
  });

  it('ID つきの行は既存の枠を直す。占有・画像・上限は残り、ブースの位置もそろう', async () => {
    await seedEvent();
    await db.doc(paths.slot('e1', 's1')).update({ 'profile.avatarPath': 'events/e1/avatars/s1', queueLimit: 7 });
    await call({ op: 'importSlots', eid: 'e1', csv: 'id,nickname,department,bio,tags,location,order\ns1,新しい名前,,,,B-9,3\n' });

    const slot = await read<StudentSlotDoc>(paths.slot('e1', 's1'));
    expect(slot).toMatchObject({ location: 'B-9', order: 3, queueLimit: 7, occupant: { uid: 'staff-s1' } });
    expect(slot.profile).toMatchObject({ nickname: '新しい名前', avatarPath: 'events/e1/avatars/s1' });
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).booths).toEqual([{ staffUid: 'staff-s1', booth: 'B-9' }]);
  });

  it('URL・SNS の ID を含む行があれば、行と列を返して何も書かない', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    const csv = `${CSV},たろう,文学部,インスタ: taro_123,,A-3,3\n,はなこ,,詳しくは https://x.example,,A-4,4\n`;
    const err = await expectReason(call({ op: 'importSlots', eid, csv }), 'containsContact');
    expect((err.details as { rows: { row: number; field: string }[] }).rows.map((r) => [r.row, r.field])).toEqual([
      [3, 'bio'],
      [4, 'bio'],
    ]);
    expect((await db.collection(paths.slots(eid)).get()).size).toBe(1); // 教員相談の枠だけ
  });

  it('CSV の誤り: 見出しの不足、必須の空欄、長すぎる値、ID の重複、教員相談の枠の ID', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    await expectReason(call({ op: 'importSlots', eid, csv: 'nickname\nあ\n' }), 'invalidInput');
    const h = 'id,nickname,department,bio,tags,location,order\n';
    await expectReason(call({ op: 'importSlots', eid, csv: `${h},,,,,,1\n` }), 'invalidInput');
    await expectReason(call({ op: 'importSlots', eid, csv: `${h},${'あ'.repeat(21)},,,,,1\n` }), 'invalidInput');
    await expectReason(call({ op: 'importSlots', eid, csv: `${h}x,a,,,,,1\nx,b,,,,,2\n` }), 'invalidInput');
    await expectReason(call({ op: 'importSlots', eid, csv: `${h}faculty,a,,,,,1\n` }), 'invalidInput');
    await expectReason(call({ op: 'importSlots', eid, csv: `${h},a,,,1 2 3 4 5 6,,1\n` }), 'invalidInput');
  });

  it('個別編集（upsertSlot）と教員相談の紹介文', async () => {
    const { eid } = await call<{ eid: string }>({ op: 'createEvent', settings: SETTINGS });
    const { slotIds } = await call<{ slotIds: string[] }>({
      op: 'upsertSlot',
      eid,
      slot: { nickname: 'ゆい', department: '国際学部 1年', bio: '', tags: ['#留学'], location: null, order: 5 },
    });
    expect((await read<StudentSlotDoc>(paths.slot(eid, slotIds[0]!))).profile.tags).toEqual(['留学']);

    await call({ op: 'updateFacultyProfile', eid, profile: { title: '教員相談', fields: ['入試'], description: '学部の先生が対応します' } });
    expect((await read<SlotDoc>(paths.slot(eid, FACULTY_SLOT_ID))).profile).toMatchObject({ title: '教員相談' });
    await expectReason(
      call({ op: 'updateFacultyProfile', eid, profile: { title: '教員相談', fields: [], description: 'LINE ID: abc' } }),
      'containsContact',
    );
  });

  it('枠の削除: 並んでいる方・担当がいれば拒否、空なら board からも消える', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2', occupied: false }] });
    await expectReason(call({ op: 'deleteSlot', eid: 'e1', slotId: 's1' }), 'slotInUse');
    await expectReason(call({ op: 'deleteSlot', eid: 'e1', slotId: FACULTY_SLOT_ID }), 'invalidInput');
    await call({ op: 'deleteSlot', eid: 'e1', slotId: 's2' });
    expect((await db.doc(paths.slot('e1', 's2')).get()).exists).toBe(false);
    expect((await db.doc(paths.queue('e1', 's2')).get()).exists).toBe(false);
    expect(Object.keys((await read<BoardDoc>(paths.board('e1'))).slots).sort()).toEqual([FACULTY_SLOT_ID, 's1']);
    // 消した枠のスタッフコードも消える
    expect((await read<SecretCodesDoc>(paths.secretCodes('e1'))).slotCodes).toEqual({ s1: SLOT_CODES.s1 });
  });

  it('プロフィール画像: 形式を中身で確かめて Storage に置き、avatarPath を入れる', async () => {
    await seedEvent();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    await call({ op: 'uploadAvatar', eid: 'e1', slotId: 's1', contentType: 'image/png', dataBase64: png.toString('base64') });

    const path = storagePaths.avatar('e1', 's1');
    expect((await read<StudentSlotDoc>(paths.slot('e1', 's1'))).profile.avatarPath).toBe(path);
    const [meta] = await getStorage().bucket(deps.bucket().name).file(path).getMetadata();
    expect(meta.contentType).toBe('image/png');

    // PNG と名乗る JPEG、HTML、大きすぎる画像、教員相談の枠は拒否
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    await expectReason(call({ op: 'uploadAvatar', eid: 'e1', slotId: 's1', contentType: 'image/png', dataBase64: jpeg.toString('base64') }), 'invalidInput');
    await expectReason(call({ op: 'uploadAvatar', eid: 'e1', slotId: 's1', contentType: 'text/html', dataBase64: 'PGgxPg==' }), 'invalidInput');
    const big = Buffer.concat([jpeg, Buffer.alloc(600 * 1024)]);
    await expectReason(call({ op: 'uploadAvatar', eid: 'e1', slotId: 's1', contentType: 'image/jpeg', dataBase64: big.toString('base64') }), 'invalidInput');
    await expectReason(call({ op: 'uploadAvatar', eid: 'e1', slotId: FACULTY_SLOT_ID, contentType: 'image/jpeg', dataBase64: jpeg.toString('base64') }), 'invalidInput');
  });

  it('URL・SNS の ID の判定', () => {
    for (const t of ['https://a.jp', 'ｈｔｔｐｓ：//a', 'www.example', 'example.com', 'meigaku.ac.jp 見てね', '@taro_123', 'インスタ: taro', 'LINE ID abc', 'Twitter：@x']) {
      expect(containsContact(t), t).toBe(true);
    }
    for (const t of ['心理学部 2年', '部活と勉強の両立', 'メールで相談した話', 'TOEIC 800点', '3.5 GPA']) {
      expect(containsContact(t), t).toBe(false);
    }
  });

  it('CSV の読み込み（クォート・改行・BOM・CRLF）', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","y\n""2"""\r\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'y\n"2"'],
    ]);
    expect(csvToSlots('id,nickname,department,bio,tags,location,order\n,a,,,タグ1、タグ2,,\n').slots[0]).toMatchObject({ tags: ['タグ1', 'タグ2'], order: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('A-05 当日の操作', () => {
  it('開場で board を作り直し、閉場で残りの整理券を無効化して問診メモを全削除する', async () => {
    await seedEvent({ state: 'scheduled' });
    await seedStaff('e1', [{ uid: 'staff-s1', role: 'student', slotId: 's1' }]);
    await call({ op: 'openEvent', eid: 'e1' });
    expect((await read<EventDoc>(paths.event('e1'))).state).toBe('open');
    await call({ op: 'openEvent', eid: 'e1' }); // 2回目は何もしない

    await seedVisitors('e1', ['a', 'b', 'c']);
    const issue = (u: string) => visitor.issueTicket(deps, visitorCaller(u), { slotId: 's1', grade: null, themes: [], memo: '秘密のメモ' });
    const [a, b, c] = [await issue('a'), await issue('b'), await issue('c')];
    await staff.callNext(deps, staffCaller('staff-s1', 'student'));
    await staff.startConsult(deps, staffCaller('staff-s1', 'student'), { ticketId: a.ticketId });
    await staff.completeConsult(deps, staffCaller('staff-s1', 'student'), { ticketId: a.ticketId });

    await call({ op: 'closeEvent', eid: 'e1' });
    expect((await read<EventDoc>(paths.event('e1'))).state).toBe('closed');
    expect((await read<TicketDoc>(paths.ticket('e1', a.ticketId))).state).toBe('completed');
    for (const t of [b, c]) expect(await read<TicketDoc>(paths.ticket('e1', t.ticketId))).toMatchObject({ state: 'expired', memo: null });
    const all = await db.collection(paths.tickets('e1')).get();
    expect(all.docs.every((d) => d.get('memo') === null)).toBe(true);
    expect(await read<QueueDoc>(paths.queue('e1', 's1'))).toMatchObject({ waiting: [], serving: [], skipped: [] });
    expect((await logs('e1')).map((l) => l.action).sort()).toEqual(['event.close', 'event.open']);

    await seedVisitors('e1', ['late']);
    await expectReason(issue('late'), 'eventNotOpen');
    await expectReason(staff.callNext(deps, staffCaller('staff-s1', 'student')), 'eventNotOpen');
    await expectReason(call({ op: 'openEvent', eid: 'e1' }), 'invalidState');
  });

  it('会場全体の一時停止: 全枠が停止になり、再開しても列ごとの停止は残る', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2', paused: true }] });
    await seedVisitors('e1', ['g']);
    await call({ op: 'setGlobalPaused', eid: 'e1', paused: true });
    const board = await read<BoardDoc>(paths.board('e1'));
    expect(board.paused).toBe(true);
    expect(Object.values(board.slots).every((s) => s.pauseReason === 'global')).toBe(true);
    await expectReason(visitor.issueTicket(deps, visitorCaller('g'), { slotId: 's1', grade: null, themes: [], memo: null }), 'globalPaused');

    await call({ op: 'setGlobalPaused', eid: 'e1', paused: false });
    const after = await read<BoardDoc>(paths.board('e1'));
    expect(after.slots['s1']!.status).toBe('available');
    expect(after.slots['s2']).toMatchObject({ status: 'paused', pauseReason: 'staff' });
    expect((await logs('e1')).map((l) => l.action).sort()).toEqual(['event.pause', 'event.resume']);
  });

  it('列ごとの停止と上限変更（管理者はどの列でも）。上限変更は履歴に残る', async () => {
    await seedEvent();
    await call({ op: 'updateSlotSettings', eid: 'e1', slotId: FACULTY_SLOT_ID, paused: true, queueLimit: 60 });
    expect(await read<SlotDoc>(paths.slot('e1', FACULTY_SLOT_ID))).toMatchObject({ paused: true, queueLimit: 60 });
    expect((await read<BoardDoc>(paths.board('e1'))).slots[FACULTY_SLOT_ID]).toMatchObject({ pauseReason: 'staff', queueLimit: 60 });
    const limit = (await logs('e1')).find((l) => l.action === 'queueLimit.change');
    expect(limit).toMatchObject({ target: FACULTY_SLOT_ID, detail: { from: 40, to: 60 }, actor: { role: 'admin' } });
    await expectReason(call({ op: 'updateSlotSettings', eid: 'e1', slotId: 's1', queueLimit: 11 }), 'invalidInput');
  });

  it('強制解除: 学生の占有を外し、対応中の整理券は次の担当が引き継げる', async () => {
    await seedEvent();
    await seedStaff('e1', [{ uid: 'staff-s1', role: 'student', slotId: 's1' }, { uid: 'next', role: 'student', allowedSlotId: 's1' }]);
    await seedVisitors('e1', ['f']);
    const t = await visitor.issueTicket(deps, visitorCaller('f'), { slotId: 's1', grade: null, themes: [], memo: null });
    await staff.callNext(deps, staffCaller('staff-s1', 'student'));

    await expectReason(call({ op: 'forceRelease', eid: 'e1', slotId: 's1', staffUid: 'someone' }), 'notAssigned');
    await call({ op: 'forceRelease', eid: 'e1', slotId: 's1', staffUid: 'staff-s1' });
    expect((await read<SlotDoc>(paths.slot('e1', 's1'))).occupant).toBeNull();
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).serving[0]).toMatchObject({ ticketId: t.ticketId, staffUid: null });
    await expectReason(staff.callNext(deps, staffCaller('staff-s1', 'student')), 'notAssigned');

    const next = staffCaller('next', 'student');
    await staff.claimSlot(deps, next, { slotId: 's1' });
    await staff.startConsult(deps, next, { ticketId: t.ticketId });
    await staff.completeConsult(deps, next, { ticketId: t.ticketId });
    expect(await read<TicketDoc>(paths.ticket('e1', t.ticketId))).toMatchObject({ state: 'completed', staffUid: 'next' });
  });

  it('強制解除: 教員のブースを外し、ほかの教員が対応中の整理券を引き継げる', async () => {
    await seedEvent({ facultyBooths: 2 });
    await seedStaff('e1', [
      { uid: 'fac-0', role: 'faculty', booth: 'F-1' },
      { uid: 'fac-1', role: 'faculty', booth: 'F-2' },
    ]);
    await seedVisitors('e1', ['f']);
    const t = await visitor.issueTicket(deps, visitorCaller('f'), { slotId: FACULTY_SLOT_ID, grade: null, themes: [], memo: null });
    await staff.callNext(deps, staffCaller('fac-0', 'faculty'));

    await call({ op: 'forceRelease', eid: 'e1', slotId: FACULTY_SLOT_ID, staffUid: 'fac-0' });
    expect((await read<BoardDoc>(paths.board('e1'))).slots[FACULTY_SLOT_ID]!.activeBooths).toBe(1);
    await staff.skipTicket(deps, staffCaller('fac-1', 'faculty'), { ticketId: t.ticketId });
    expect((await read<TicketDoc>(paths.ticket('e1', t.ticketId))).state).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------

describe('A-06 ダッシュボード・A-07 統計', () => {
  it('直近10分の発券数・コードの失敗数と警告', async () => {
    await seedEvent({ studentSlots: [{ id: 's1', queueLimit: 10 }] });
    const uids = Array.from({ length: 3 }, (_, i) => `d${i}`);
    await seedVisitors('e1', uids);
    for (const u of uids) await visitor.issueTicket(deps, visitorCaller(u), { slotId: 's1', grade: null, themes: [], memo: null });
    for (let i = 0; i < 4; i++) await expectReason(staff.staffLogin(deps, anonymous(`bad-${i}`), { code: '00000000' }), 'wrongCode');
    await expectReason(visitor.enterEvent(deps, anonymous('bad-v'), { code: '0000000' }), 'wrongCode');

    const res = await call<{ issuedLast10m: number; staffFailuresLast10m: number; entryFailuresLast10m: number; warnings: string[] }>({ op: 'dashboard', eid: 'e1' });
    expect(res).toEqual({ issuedLast10m: 3, staffFailuresLast10m: 4, entryFailuresLast10m: 1, warnings: [] });

    // 10分たてば数えない
    const later = await call<{ issuedLast10m: number }>({ op: 'dashboard', eid: 'e1' }, makeDeps(new Date(NOW.getTime() + 11 * 60_000)));
    expect(later.issuedLast10m).toBe(0);
  });

  it('統計: 学年×テーマ、平均の待ち・相談時間、時間帯別の発券数（JST）', () => {
    const t = (over: Partial<TicketDoc>): TicketDoc =>
      ({ grade: null, themes: [], state: 'waiting', createdAt: ts('10:05'), calledAt: null, startedAt: null, completedAt: null, ...over }) as TicketDoc;
    function ts(hhmm: string) {
      return Timestamp.fromDate(new Date(`2027-03-20T${hhmm}:00+09:00`));
    }
    const event = { opensAt: ts("10:00") } as unknown as EventDoc;
    const stats = buildStats(event, [
      t({ grade: '高校3年', themes: ['入試', '授業'], state: 'completed', calledAt: ts('10:15'), startedAt: ts('10:17'), completedAt: ts('10:27') }),
      t({ grade: '高校3年', themes: ['入試'], state: 'completed', createdAt: ts('11:00'), calledAt: ts('11:20'), startedAt: ts('11:20'), completedAt: ts('11:28') }),
      t({ state: 'canceled', createdAt: ts('11:30') }),
      t({ grade: '保護者', themes: ['入試'], state: 'expired' }),
    ]);
    expect(stats).toEqual({
      date: '2027-03-20',
      issued: 4,
      completed: 2,
      canceled: 1,
      expired: 1,
      gradeTheme: { 高校3年: { 入試: 2, 授業: 1 }, 未回答: { '(テーマなし)': 1 }, 保護者: { 入試: 1 } },
      avgWaitSeconds: 900,
      avgConsultSeconds: 540,
      issuedByHour: { '10': 2, '11': 2 },
    });
  });

  it('previewStats は当日の整理券から計算するだけで保存しない', async () => {
    await seedEvent();
    await seedVisitors('e1', ['p']);
    await visitor.issueTicket(deps, visitorCaller('p'), { slotId: 's1', grade: '高校2年', themes: ['入試'], memo: null });
    const stats = await call<{ issued: number; gradeTheme: unknown }>({ op: 'previewStats', eid: 'e1' });
    expect(stats).toMatchObject({ issued: 1, gradeTheme: { 高校2年: { 入試: 1 } } });
    expect((await db.collection(`events/e1/stats`).get()).size).toBe(0);
  });
});
