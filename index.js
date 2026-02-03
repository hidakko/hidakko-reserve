/**
 * Hidakko Reservation System - Firebase Functions (Gen 2)
 * Express API mounted at /api via Firebase Hosting rewrites
 *
 * Data model:
 * reservations/{id}
 *   - code: "000001" (6 digits)
 * seats/{date}/slots/{time}
 * public/coupon
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const express = require("express");
const cors = require("cors");

const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

/** ====== Config ====== */
const ADMIN_PIN = String(process.env.ADMIN_PIN ?? "2881").trim();
const LINE_CHANNEL_ACCESS_TOKEN = String(process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim();

/** ====== Constants ======
 * 予約枠：11:30〜13:30（30分刻み）
 */
const DEFAULT_SLOT_TIMES = ["11:30", "12:00", "12:30", "13:00", "13:30"];

/** ====== Helpers ====== */
function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isHHmm(s) {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}
function nowIso() {
  return new Date().toISOString();
}
function todayJstYmd() {
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return nowJst.toISOString().slice(0, 10);
}
function daysDiff(fromYmd, toYmd) {
  const a = new Date(fromYmd + "T00:00:00Z");
  const b = new Date(toYmd + "T00:00:00Z");
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}
function clampNonNegativeInt(n, fallback) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return v;
}
function assertAdminPin(pin) {
  if (String(pin ?? "").trim() !== ADMIN_PIN) {
    const e = new Error("管理PINが違います。");
    e.status = 403;
    throw e;
  }
}
function assertChangeAllowed(targetDateYmd) {
  const today = todayJstYmd();
  const diff = daysDiff(today, targetDateYmd);
  if (diff < 2) {
    const e = new Error("変更は2日前まで可能です。");
    e.status = 403;
    throw e;
  }
}
function isWeekendYmd(ymd) {
  if (!isYmd(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun, 6 Sat
  return w === 0 || w === 6;
}
function normalizePhone(s) {
  return String(s || "").replace(/[^\d]/g, "");
}
function pad6(n) {
  return String(n).padStart(6, "0");
}
function seatRef(date, time) {
  return db.collection("seats").doc(date).collection("slots").doc(time);
}

/** ====== Short reservation code issuing (transaction) ====== */
async function issueReservationCodeTx(tx) {
  const ref = db.collection("counters").doc("reservation");
  const snap = await tx.get(ref); // ★read first
  const cur = snap.exists ? Number(snap.data().next || 0) : 0;

  const next = cur + 1;
  if (next > 999999) {
    const e = new Error("予約番号の上限に達しました（999999）。");
    e.status = 500;
    throw e;
  }

  tx.set(ref, { next }, { merge: true }); // ★write after read
  return pad6(next);
}

/** ====== Seats defaults ====== */
function defaultSeatDoc() {
  return {
    counterTotal: 4,
    table2Total: 1,
    tableLargeTotal: 3,
    zashikiTotal: 1,
    zashikiEnabled: true,

    counterReserved: 0,
    table2Reserved: 0,
    tableLargeReserved: 0,
    zashikiReserved: 0,
  };
}
function normalizeSeat(data) {
  const d = { ...defaultSeatDoc(), ...(data || {}) };

  d.counterTotal = Number.isFinite(+d.counterTotal) ? +d.counterTotal : 4;
  d.table2Total = Number.isFinite(+d.table2Total) ? +d.table2Total : 1;
  d.tableLargeTotal = Number.isFinite(+d.tableLargeTotal) ? +d.tableLargeTotal : 3;
  d.zashikiTotal = Number.isFinite(+d.zashikiTotal) ? +d.zashikiTotal : 1;

  d.counterReserved = Number.isFinite(+d.counterReserved) ? +d.counterReserved : 0;
  d.table2Reserved = Number.isFinite(+d.table2Reserved) ? +d.table2Reserved : 0;
  d.tableLargeReserved = Number.isFinite(+d.tableLargeReserved) ? +d.tableLargeReserved : 0;
  d.zashikiReserved = Number.isFinite(+d.zashikiReserved) ? +d.zashikiReserved : 0;

  d.zashikiEnabled = d.zashikiEnabled !== false;

  d.counterTotal = Math.max(0, d.counterTotal);
  d.table2Total = Math.max(0, d.table2Total);
  d.tableLargeTotal = Math.max(0, d.tableLargeTotal);
  d.zashikiTotal = Math.max(0, d.zashikiTotal);

  d.counterReserved = Math.max(0, d.counterReserved);
  d.table2Reserved = Math.max(0, d.table2Reserved);
  d.tableLargeReserved = Math.max(0, d.tableLargeReserved);
  d.zashikiReserved = Math.max(0, d.zashikiReserved);

  return d;
}
function toSlotView(time, seat) {
  const s = normalizeSeat(seat);

  const counterRemain = Math.max(0, s.counterTotal - s.counterReserved);
  const table2Remain = Math.max(0, s.table2Total - s.table2Reserved);
  const tableLargeRemain = Math.max(0, s.tableLargeTotal - s.tableLargeReserved);
  const zashikiRemain = s.zashikiEnabled ? Math.max(0, s.zashikiTotal - s.zashikiReserved) : 0;

  return {
    time,
    counterRemain,
    table2Remain,
    tableLargeRemain,
    zashikiRemain,
    zashikiEnabled: !!s.zashikiEnabled,

    counterTotal: s.counterTotal,
    table2Total: s.table2Total,
    tableLargeTotal: s.tableLargeTotal,
    zashikiTotal: s.zashikiTotal,

    counterReserved: s.counterReserved,
    table2Reserved: s.table2Reserved,
    tableLargeReserved: s.tableLargeReserved,
    zashikiReserved: s.zashikiReserved,
  };
}

/** ====== LINE push ====== */
async function sendLinePush(lineUserId, message) {
  if (!lineUserId || !LINE_CHANNEL_ACCESS_TOKEN) return;

  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: "text", text: message }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error("LINE push failed", { status: resp.status, text });
    }
  } catch (err) {
    logger.error("LINE push error", err);
  }
}

/** ====== SeatType helpers ====== */
function seatTypeLabel(seatType) {
  if (seatType === "table2") return "テーブル（2人）";
  if (seatType === "tableLarge") return "テーブル（3〜6人）";
  if (seatType === "zashiki") return "座敷";
  return "カウンター";
}

function addReserveToSeat(tx, sRef, seatDoc, seatType) {
  const s = normalizeSeat(seatDoc);

  if (seatType === "zashiki") {
    if (!s.zashikiEnabled) {
      const e = new Error("座敷は受付停止です");
      e.status = 400;
      throw e;
    }
    if (s.zashikiReserved + 1 > s.zashikiTotal) {
      const e = new Error("座敷が満席です");
      e.status = 400;
      throw e;
    }
    tx.set(sRef, { ...s, zashikiReserved: s.zashikiReserved + 1 }, { merge: true });
    return;
  }

  if (seatType === "table2") {
    if (s.table2Reserved + 1 > s.table2Total) {
      const e = new Error("テーブル（2人）が満席です");
      e.status = 400;
      throw e;
    }
    tx.set(sRef, { ...s, table2Reserved: s.table2Reserved + 1 }, { merge: true });
    return;
  }

  if (seatType === "tableLarge") {
    if (s.tableLargeReserved + 1 > s.tableLargeTotal) {
      const e = new Error("テーブル（3〜6人）が満席です");
      e.status = 400;
      throw e;
    }
    tx.set(sRef, { ...s, tableLargeReserved: s.tableLargeReserved + 1 }, { merge: true });
    return;
  }

  // counter
  if (s.counterReserved + 1 > s.counterTotal) {
    const e = new Error("カウンターが満席です");
    e.status = 400;
    throw e;
  }
  tx.set(sRef, { ...s, counterReserved: s.counterReserved + 1 }, { merge: true });
}

function releaseReserveFromSeat(tx, sRef, seatDoc, seatType) {
  const s = normalizeSeat(seatDoc);

  if (seatType === "zashiki") {
    tx.set(sRef, { ...s, zashikiReserved: Math.max(0, s.zashikiReserved - 1) }, { merge: true });
    return;
  }
  if (seatType === "table2") {
    tx.set(sRef, { ...s, table2Reserved: Math.max(0, s.table2Reserved - 1) }, { merge: true });
    return;
  }
  if (seatType === "tableLarge") {
    tx.set(sRef, { ...s, tableLargeReserved: Math.max(0, s.tableLargeReserved - 1) }, { merge: true });
    return;
  }
  tx.set(sRef, { ...s, counterReserved: Math.max(0, s.counterReserved - 1) }, { merge: true });
}

/** ====== Seat allocation rule ====== */
function chooseSeatTypeEither(people, seatDoc) {
  const s = normalizeSeat(seatDoc);

  const counterRemain = s.counterTotal - s.counterReserved;
  const table2Remain = s.table2Total - s.table2Reserved;
  const tableLargeRemain = s.tableLargeTotal - s.tableLargeReserved;
  const zashikiRemain = s.zashikiEnabled ? (s.zashikiTotal - s.zashikiReserved) : 0;

  const can = {
    counter: counterRemain > 0,
    table2: table2Remain > 0,
    tableLarge: tableLargeRemain > 0,
    zashiki: zashikiRemain > 0,
  };

  const order =
    people <= 2
      ? ["table2", "counter", "tableLarge", "zashiki"]
      : people <= 6
        ? ["tableLarge", "zashiki", "counter", "table2"]
        : ["zashiki", "tableLarge", "counter", "table2"];

  for (const t of order) {
    if (t === "zashiki" && !s.zashikiEnabled) continue;
    if (can[t]) return t;
  }
  return null;
}

function chooseSeatTypeTable(people, seatDoc) {
  const s = normalizeSeat(seatDoc);

  const table2Remain = s.table2Total - s.table2Reserved;
  const tableLargeRemain = s.tableLargeTotal - s.tableLargeReserved;
  const zashikiRemain = s.zashikiEnabled ? (s.zashikiTotal - s.zashikiReserved) : 0;

  if (people <= 2) {
    if (table2Remain > 0) return "table2";
    if (tableLargeRemain > 0) return "tableLarge";
    return null;
  }
  if (people <= 6) {
    if (tableLargeRemain > 0) return "tableLarge";
    return null;
  }
  if (zashikiRemain > 0) return "zashiki";
  return null;
}

/** ====== API ====== */

/**
 * GET /api/availability?date=YYYY-MM-DD
 * 週末は closed:true を返す（UIも詰まない）
 */
app.get("/api/availability", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    if (!isYmd(date)) return res.status(400).json({ error: "date が不正です" });

    if (isWeekendYmd(date)) {
      return res.json({ date, closed: true, reason: "土日は休みです。", slots: [] });
    }

    const slotsCol = db.collection("seats").doc(date).collection("slots");
    const snap = await slotsCol.get();
    const byTime = new Map();
    snap.forEach((d) => byTime.set(d.id, d.data()));

    const slots = DEFAULT_SLOT_TIMES.map((t) => toSlotView(t, byTime.get(t)));
    return res.json({ date, closed: false, slots });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ error: "サーバーエラー" });
  }
});

/**
 * POST /api/reservations
 * body: {date,time,people,seatPref,name,phone,note,lineUserId?}
 * ★短い予約番号 code(6桁) を発行して返す
 */
app.post("/api/reservations", async (req, res) => {
  try {
    const { date, time, people, seatPref, name, phone, note, lineUserId } = req.body || {};

    if (!isYmd(date)) return res.status(400).json({ error: "date が不正です" });
    if (isWeekendYmd(date)) return res.status(400).json({ error: "土日は休みです（平日を選んでください）" });
    if (!isHHmm(time) || !DEFAULT_SLOT_TIMES.includes(time)) return res.status(400).json({ error: "time が不正です" });

    const p = clampNonNegativeInt(people, 1);
    if (p < 1 || p > 20) return res.status(400).json({ error: "人数が不正です" });

    const pref = ["counter", "zashiki", "table", "either"].includes(seatPref) ? seatPref : "either";

    const nm = (name || "").trim();
    const ph = normalizePhone(phone);
    if (!nm) return res.status(400).json({ error: "お名前を入力してください" });
    if (!ph) return res.status(400).json({ error: "電話番号を入力してください" });

    // ★発券→予約保存（同一トランザクション）
    const result = await db.runTransaction(async (tx) => {
      const code = await issueReservationCodeTx(tx);

      const docRef = db.collection("reservations").doc();
      const r = {
        code, // 6桁予約番号
        date,
        time,
        people: p,
        seatPref: pref,
        seatType: null,
        name: nm,
        phone: ph,
        note: (note || "").toString().slice(0, 500),
        status: "pending",
        lineUserId: lineUserId || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      tx.set(docRef, r);
      return { id: docRef.id, code, lineUserId: lineUserId || null };
    });

    // LINE通知（codeを載せる）
    if (result.lineUserId) {
      await sendLinePush(
        result.lineUserId,
        `【ひだっこ】仮予約を受け付けました。\n予約番号：${result.code}\n日時：${date} ${time}\n承認後に確定通知をお送りします。`
      );
    }

    return res.json({ id: result.id, code: result.code });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/**
 * POST /api/reservations/lookup
 * body: { code, phone }  ※旧互換で { id, phone } も許可
 */
app.post("/api/reservations/lookup", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const id = String(req.body?.id || "").trim(); // 旧互換
    const phone = normalizePhone(req.body?.phone);

    if ((!code && !id) || !phone) {
      return res.status(400).json({ error: "code または id と phone が必要です" });
    }

    // 新方式：codeで検索 → 電話チェック
    if (code) {
      const snap = await db.collection("reservations")
        .where("code", "==", code)
        .limit(1)
        .get();

      if (snap.empty) return res.status(404).json({ error: "見つかりません" });

      const doc = snap.docs[0];
      const r = doc.data();

      if (normalizePhone(r.phone) !== phone) {
        return res.status(403).json({ error: "電話番号が違います" });
      }
      return res.json({ id: doc.id, ...r });
    }

    // 旧方式：id直参照
    const doc = await db.collection("reservations").doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "見つかりません" });

    const r = doc.data();
    if (normalizePhone(r.phone) !== phone) {
      return res.status(403).json({ error: "電話番号が違います" });
    }
    return res.json({ id: doc.id, ...r });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/**
 * PATCH /api/reservations/:id
 */
app.patch("/api/reservations/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { phone, date, time, people, seatPref, note } = req.body || {};
    const ph = normalizePhone(phone);
    if (!ph) return res.status(400).json({ error: "phone が必要です" });

    await db.runTransaction(async (tx) => {
      const rRef = db.collection("reservations").doc(id);
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) {
        const e = new Error("見つかりません");
        e.status = 404;
        throw e;
      }
      const r = rSnap.data();

      if (normalizePhone(r.phone) !== ph) {
        const e = new Error("電話番号が違います");
        e.status = 403;
        throw e;
      }

      // 元の予約日基準で 2日前まで
      assertChangeAllowed(r.date);

      const next = { ...r };

      if (date) {
        if (!isYmd(date)) {
          const e = new Error("date が不正です");
          e.status = 400;
          throw e;
        }
        if (isWeekendYmd(date)) {
          const e = new Error("土日は休みです（平日を選んでください）");
          e.status = 400;
          throw e;
        }
        assertChangeAllowed(date);
        next.date = date;
      }

      if (time) {
        if (!isHHmm(time) || !DEFAULT_SLOT_TIMES.includes(time)) {
          const e = new Error("time が不正です");
          e.status = 400;
          throw e;
        }
        next.time = time;
      }

      if (people !== undefined) {
        const pp = clampNonNegativeInt(people, next.people || 1);
        if (pp < 1 || pp > 20) {
          const e = new Error("人数が不正です");
          e.status = 400;
          throw e;
        }
        next.people = pp;
      }

      if (seatPref) {
        next.seatPref = ["counter", "zashiki", "table", "either"].includes(seatPref) ? seatPref : next.seatPref;
      }
      if (note !== undefined) next.note = (note || "").toString().slice(0, 500);

      // confirmed なら元席の reserved を戻す
      if (r.status === "confirmed" && r.seatType && r.date && r.time) {
        const sRef = seatRef(r.date, r.time);
        const sSnap = await tx.get(sRef);
        releaseReserveFromSeat(tx, sRef, sSnap.exists ? sSnap.data() : null, r.seatType);
      }

      tx.update(rRef, {
        date: next.date,
        time: next.time,
        people: next.people,
        seatPref: next.seatPref,
        seatType: null,
        note: next.note,
        status: "pending", // 再承認
        updatedAt: nowIso(),
      });
    });

    return res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/**
 * POST /api/reservations/:id/cancel
 */
app.post("/api/reservations/:id/cancel", async (req, res) => {
  try {
    const id = req.params.id;
    const ph = normalizePhone(req.body?.phone);
    if (!ph) return res.status(400).json({ error: "phone が必要です" });

    await db.runTransaction(async (tx) => {
      const rRef = db.collection("reservations").doc(id);
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) {
        const e = new Error("見つかりません");
        e.status = 404;
        throw e;
      }
      const r = rSnap.data();

      if (normalizePhone(r.phone) !== ph) {
        const e = new Error("電話番号が違います");
        e.status = 403;
        throw e;
      }

      if (r.status === "confirmed" && r.seatType && r.date && r.time) {
        const sRef = seatRef(r.date, r.time);
        const sSnap = await tx.get(sRef);
        releaseReserveFromSeat(tx, sRef, sSnap.exists ? sSnap.data() : null, r.seatType);
      }

      tx.update(rRef, { status: "canceled", updatedAt: nowIso() });
    });

    return res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/** ====== Admin ====== */

app.post("/api/admin/pending", async (req, res) => {
  try {
    const { pin } = req.body || {};
    assertAdminPin(pin);

    const date = String(req.query.date || "");
    if (!isYmd(date)) return res.status(400).json({ error: "date が不正です" });

    const snap = await db.collection("reservations")
      .where("date", "==", date)
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .get();

    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ date, list });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

app.post("/api/admin/reservations/:id/approve", async (req, res) => {
  try {
    const { pin } = req.body || {};
    assertAdminPin(pin);

    const id = req.params.id;

    let lineUserId = null;
    let confirmedPayload = null;
    let code = null;

    await db.runTransaction(async (tx) => {
      const rRef = db.collection("reservations").doc(id);
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) {
        const e = new Error("見つかりません");
        e.status = 404;
        throw e;
      }
      const r = rSnap.data();
      if (r.status !== "pending") {
        const e = new Error("この予約は承認待ちではありません");
        e.status = 400;
        throw e;
      }
      if (!isYmd(r.date) || !isHHmm(r.time)) {
        const e = new Error("予約データが不正です");
        e.status = 400;
        throw e;
      }

      const sRef = seatRef(r.date, r.time);
      const sSnap = await tx.get(sRef);
      const s = normalizeSeat(sSnap.exists ? sSnap.data() : null);

      const people = Number(r.people || 1);

      let seatType = "counter";

      if (r.seatPref === "counter") {
        seatType = "counter";
      } else if (r.seatPref === "zashiki") {
        seatType = "zashiki";
      } else if (r.seatPref === "table") {
        const picked = chooseSeatTypeTable(people, s);
        if (!picked) {
          const e = new Error("テーブル希望ですが空きがありません");
          e.status = 400;
          throw e;
        }
        seatType = picked;
      } else {
        const picked = chooseSeatTypeEither(people, s);
        if (!picked) {
          const e = new Error("満席です（全席種）");
          e.status = 400;
          throw e;
        }
        seatType = picked;
      }

      addReserveToSeat(tx, sRef, s, seatType);

      tx.update(rRef, {
        status: "confirmed",
        seatType,
        confirmedAt: nowIso(),
        updatedAt: nowIso(),
      });

      lineUserId = r.lineUserId || null;
      confirmedPayload = { date: r.date, time: r.time, seatType };
      code = r.code || null;
    });

    if (lineUserId && confirmedPayload) {
      await sendLinePush(
        lineUserId,
        `【ひだっこ】ご予約が確定しました。\n予約番号：${code || ""}\n日時：${confirmedPayload.date} ${confirmedPayload.time}\n席：${seatTypeLabel(confirmedPayload.seatType)}\n当日お待ちしております。`
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

app.post("/api/admin/reservations/:id/reject", async (req, res) => {
  try {
    const { pin, reason } = req.body || {};
    assertAdminPin(pin);

    const id = req.params.id;

    let lineUserId = null;
    let code = null;

    await db.runTransaction(async (tx) => {
      const rRef = db.collection("reservations").doc(id);
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) {
        const e = new Error("見つかりません");
        e.status = 404;
        throw e;
      }
      const r = rSnap.data();
      if (r.status !== "pending") {
        const e = new Error("この予約は承認待ちではありません");
        e.status = 400;
        throw e;
      }

      tx.update(rRef, {
        status: "rejected",
        rejectReason: (reason || "").toString().slice(0, 200),
        updatedAt: nowIso(),
      });

      lineUserId = r.lineUserId || null;
      code = r.code || null;
    });

    if (lineUserId) {
      await sendLinePush(
        lineUserId,
        `【ひだっこ】申し訳ありません。ご予約をお受けできませんでした。\n予約番号：${code || ""}\n${reason ? "理由：" + reason : ""}`
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/**
 * POST /api/admin/seats?date=YYYY-MM-DD
 */
app.post("/api/admin/seats", async (req, res) => {
  try {
    const { pin } = req.body || {};
    assertAdminPin(pin);

    const date = String(req.query.date || "");
    if (!isYmd(date)) return res.status(400).json({ error: "date が不正です" });

    const snap = await db.collection("seats").doc(date).collection("slots").get();
    const byTime = new Map();
    snap.forEach((d) => byTime.set(d.id, d.data()));

    const slots = DEFAULT_SLOT_TIMES.map((t) => toSlotView(t, byTime.get(t)));
    return res.json({ date, slots });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/**
 * POST /api/admin/seats/update?date=YYYY-MM-DD
 */
app.post("/api/admin/seats/update", async (req, res) => {
  try {
    const { pin, time, counterTotal, table2Total, tableLargeTotal, zashikiTotal, zashikiEnabled } = req.body || {};
    assertAdminPin(pin);

    const date = String(req.query.date || "");
    if (!isYmd(date)) return res.status(400).json({ error: "date が不正です" });
    if (!isHHmm(time) || !DEFAULT_SLOT_TIMES.includes(time)) return res.status(400).json({ error: "time が不正です" });

    const ct = clampNonNegativeInt(counterTotal, 4);
    const t2 = clampNonNegativeInt(table2Total, 1);
    const tl = clampNonNegativeInt(tableLargeTotal, 3);
    const zt = clampNonNegativeInt(zashikiTotal, 1);
    const ze = zashikiEnabled !== false;

    await db.runTransaction(async (tx) => {
      const ref = seatRef(date, time);
      const snap = await tx.get(ref);
      const s = normalizeSeat(snap.exists ? snap.data() : null);

      tx.set(ref, {
        ...s,
        counterTotal: ct,
        table2Total: t2,
        tableLargeTotal: tl,
        zashikiTotal: zt,
        zashikiEnabled: ze,
      }, { merge: true });
    });

    return res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/**
 * POST /api/admin/seats/bulk?date=YYYY-MM-DD
 * ★トランザクション禁止：batchで一括更新（read不要）
 */
app.post("/api/admin/seats/bulk", async (req, res) => {
  try {
    const { pin, counterTotal, table2Total, tableLargeTotal, zashikiTotal, zashikiEnabled } = req.body || {};
    assertAdminPin(pin);

    const date = String(req.query.date || "");
    if (!isYmd(date)) return res.status(400).json({ error: "date が不正です" });

    const ct = clampNonNegativeInt(counterTotal, 4);
    const t2 = clampNonNegativeInt(table2Total, 1);
    const tl = clampNonNegativeInt(tableLargeTotal, 3);
    const zt = clampNonNegativeInt(zashikiTotal, 1);
    const ze = zashikiEnabled !== false;

    const patch = {
      counterTotal: ct,
      table2Total: t2,
      tableLargeTotal: tl,
      zashikiTotal: zt,
      zashikiEnabled: ze,
      updatedAt: nowIso(),
    };

    const batch = db.batch();
    for (const t of DEFAULT_SLOT_TIMES) {
      batch.set(seatRef(date, t), patch, { merge: true });
    }
    await batch.commit();

    return res.json({ ok: true, date });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

/** ====== Coupon ====== */
app.get("/api/coupon", async (req, res) => {
  try {
    const doc = await db.collection("public").doc("coupon").get();
    if (!doc.exists) {
      return res.json({ title: "現在クーポンはありません", body: "", validUntil: "" });
    }
    return res.json(doc.data());
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ error: "サーバーエラー" });
  }
});

app.post("/api/admin/coupon", async (req, res) => {
  try {
    const { pin, title, body, validUntil } = req.body || {};
    assertAdminPin(pin);

    await db.collection("public").doc("coupon").set(
      {
        title: (title || "").toString().slice(0, 60),
        body: (body || "").toString().slice(0, 800),
        validUntil: (validUntil || "").toString().slice(0, 20),
        updatedAt: nowIso(),
      },
      { merge: true }
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "サーバーエラー" });
  }
});

exports.api = onRequest(app);
