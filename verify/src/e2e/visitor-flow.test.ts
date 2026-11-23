// Functions Emulator 経由の E2E（npm run test:e2e）。
// callable の配線（クレーム付与→トークン更新→発券→ルールで自分の整理券を読む）と、
// 新規登録を匿名に限るブロッキング関数を確かめる。
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInAnonymously,
} from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FUNCTION_NAMES,
  REGION,
  paths,
  type EnterEventRequest,
  type EnterEventResponse,
  type IssueTicketRequest,
  type IssueTicketResponse,
} from '@nt/shared';
import { ENTRY_CODE, PROJECT_ID, auth as adminAuth, clearFirestore, seedEvent } from '../p2/fixture.js';

let app: FirebaseApp;

beforeEach(async () => {
  await clearFirestore();
  await seedEvent();
  app = initializeApp({ apiKey: 'demo-key', projectId: PROJECT_ID, appId: 'demo-app' }, `e2e-${Date.now()}`);
});

afterEach(async () => {
  await deleteApp(app);
});

function clients() {
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
  connectFirestoreEmulator(db, host!, Number(port));
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  return { auth, db, fns };
}

describe('来場者の一巡（Functions Emulator）', () => {
  it('匿名ログイン → 入場 → トークン更新 → 発券 → 自分の整理券を読める', async () => {
    const { auth, db, fns } = clients();
    const { user } = await signInAnonymously(auth);

    const enter = httpsCallable<EnterEventRequest, EnterEventResponse>(fns, FUNCTION_NAMES.enterEvent);
    const { data } = await enter({ code: ENTRY_CODE });
    expect(data.eid).toBe('e1');

    const token = await user.getIdTokenResult(true);
    expect(token.claims).toMatchObject({ eid: 'e1', role: 'visitor' });

    const issue = httpsCallable<IssueTicketRequest, IssueTicketResponse>(fns, FUNCTION_NAMES.issueTicket);
    const ticket = await issue({ slotId: 's1', grade: '高校2年', themes: ['入試'], memo: null });
    expect(ticket.data.number).toBe(101);

    const snap = await getDoc(doc(db, paths.ticket('e1', ticket.data.ticketId)));
    expect(snap.data()).toMatchObject({ state: 'waiting', visitorUid: user.uid });
  });

  it('入場コードが違えば details.reason = wrongCode', async () => {
    const { auth, fns } = clients();
    await signInAnonymously(auth);
    const enter = httpsCallable(fns, FUNCTION_NAMES.enterEvent);
    await expect(enter({ code: '0000000' })).rejects.toMatchObject({
      code: 'functions/permission-denied',
      details: { reason: 'wrongCode' },
    });
  });

  it('メール/パスワードの新規登録はブロッキング関数で拒否される', async () => {
    const { auth } = clients();
    const email = `x${Date.now()}@example.com`;
    const err = await createUserWithEmailAndPassword(auth, email, 'abcdefghijkl').then(
      () => null,
      (e: Error) => e,
    );
    // Emulator ではコードが auth/internal-error になり、関数のエラーはメッセージに入る（本番のコードは P4 で確認）
    expect(err?.message).toContain('sign-up is not allowed');
    await expect(adminAuth.getUserByEmail(email)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
});
