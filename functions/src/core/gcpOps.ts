// 本番の Cloud Run / Cloud Monitoring REST API 呼び出し。
// 新規パッケージを増やさず、firebase-admin の ADC トークンと Node 標準の fetch で通信する。
import { applicationDefault } from 'firebase-admin/app';
import { REGION } from '@nt/shared';

/** 常駐台数を自動切替する Cloud Run サービス名（Cloud Functions v2 の issueTicket / callNext） */
const HOT_SERVICES = ['issueticket', 'callnext'] as const;
const JST_OFFSET_MS = 9 * 60 * 60_000;

function projectId(): string | null {
  return process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? null;
}

async function accessToken(): Promise<string> {
  const { access_token } = await applicationDefault().getAccessToken();
  if (!access_token) throw new Error('failed to obtain GCP access token');
  return access_token;
}

/**
 * issueTicket・callNext の Cloud Run サービス最小インスタンス数（minInstanceCount）を count に揃える。
 * 1つでも変更したら true、すでに目標値と一致していれば false を返す。
 */
export async function setHotInstances(count: 0 | 1): Promise<boolean> {
  const project = projectId();
  if (!project) return false;
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let changed = false;

  for (const service of HOT_SERVICES) {
    const baseUrl = `https://run.googleapis.com/v2/projects/${project}/locations/${REGION}/services/${service}`;
    const getRes = await fetch(baseUrl, { headers });
    if (!getRes.ok) {
      throw new Error(`Cloud Run GET ${service} failed: ${getRes.status} ${await getRes.text()}`);
    }
    const body = (await getRes.json()) as { template?: { scaling?: { minInstanceCount?: number } } };
    const current = body.template?.scaling?.minInstanceCount ?? 0;
    if (current === count) continue;

    const patchRes = await fetch(`${baseUrl}?updateMask=template.scaling.minInstanceCount`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ template: { scaling: { minInstanceCount: count } } }),
    });
    if (!patchRes.ok) {
      throw new Error(`Cloud Run PATCH ${service} failed: ${patchRes.status} ${await patchRes.text()}`);
    }
    changed = true;
  }
  return changed;
}

/** YYYY-MM-DD（JST）を返す */
export function jstDateString(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 本日（JST 0:00〜現在）の Firestore ドキュメント読み取り合計を Cloud Monitoring から取得する。
 */
export async function getTodayFirestoreReads(now: Date): Promise<{ today: number; date: string }> {
  const date = jstDateString(now);
  const project = projectId();
  if (!project) return { today: 0, date };

  const startIso = `${date}T00:00:00+09:00`;
  const startMs = Date.parse(startIso);
  if (now.getTime() <= startMs) return { today: 0, date };

  const token = await accessToken();
  let total = 0;
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      filter: 'metric.type="firestore.googleapis.com/document/read_count"',
      'interval.startTime': new Date(startMs).toISOString(),
      'interval.endTime': now.toISOString(),
      'aggregation.alignmentPeriod': '3600s',
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Cloud Monitoring query failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      timeSeries?: { points?: { value?: { int64Value?: string; doubleValue?: number } }[] }[];
      nextPageToken?: string;
    };
    for (const series of data.timeSeries ?? []) {
      for (const point of series.points ?? []) {
        const v = point.value;
        if (v?.int64Value != null) total += Number(v.int64Value);
        else if (typeof v?.doubleValue === 'number') total += Math.round(v.doubleValue);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { today: total, date };
}
