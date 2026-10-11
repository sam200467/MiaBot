"use strict";

// 用假名或罗马音找歌：「さど」「sado」都要找到《サドマミホリック》，「senbonzakura」要找到《千本桜》。
//
// 比对的是「折叠」过的片假名，两边走同一套规则：
//   - 平假名换成片假名；
//   - 去掉浊点、半浊点（ガ→カ、パ→ハ），小字换大字（ッ→ツ、ャ→ヤ），ヲ→オ；
//   - 去掉长音符「ー」，再把拖长的元音并掉（カア→カ、トウ→ト、オオ→オ）。
// 这么粗是照着官方读音来的：公开曲库的 reading 字段就是这个写法，《千本桜》是「センホンサクラ」、
// 《シュガーソングとビターステップ》是「シユカソンクトヒタステツフ」，浊点、小字、长音全没了。
// 用户那边也就不用在乎「shuga」「shugaa」「shuga-」、「toukyou」「tokyo」该打哪个。

const SMALL = { ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ", ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ヮ: "ワ", ヵ: "カ", ヶ: "ケ", ヲ: "オ", ヰ: "イ", ヱ: "エ" };
const ROWS = {
  ア: "アカサタナハマヤラワ", イ: "イキシチニヒミリ", ウ: "ウクスツヌフムユル", エ: "エケセテネヘメレ", オ: "オコソトノホモヨロ",
};
const VOWEL_OF = {};
for (const [vowel, row] of Object.entries(ROWS)) for (const kana of row) VOWEL_OF[kana] = vowel;

function foldKana(value) {
  const katakana = String(value || "").normalize("NFKC").replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  const plain = katakana.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC")
    .replace(/[ァィゥェォッャュョヮヵヶヲヰヱ]/g, (ch) => SMALL[ch]).replace(/ー/g, "");
  let out = "";
  for (const ch of plain) {
    const before = VOWEL_OF[out.at(-1)];
    if (before && (ch === before || (before === "オ" && ch === "ウ"))) continue;
    out += ch;
  }
  return out;
}

// 罗马音 → 片假名。赫本式、训令式都收（shi/si、chi/ti、tsu/tu、fu/hu、ji/zi、sha/sya……），
// 浊音反正要折叠掉，这里照样转出来就行。整串拆不干净就不算罗马音，返回 null。
const SYLLABLES = {
  a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ",
  ka: "カ", ki: "キ", ku: "ク", ke: "ケ", ko: "コ", ga: "ガ", gi: "ギ", gu: "グ", ge: "ゲ", go: "ゴ",
  sa: "サ", si: "シ", shi: "シ", su: "ス", se: "セ", so: "ソ", za: "ザ", zi: "ジ", ji: "ジ", zu: "ズ", ze: "ゼ", zo: "ゾ",
  ta: "タ", ti: "チ", chi: "チ", tu: "ツ", tsu: "ツ", te: "テ", to: "ト", da: "ダ", di: "ヂ", du: "ヅ", de: "デ", do: "ド",
  na: "ナ", ni: "ニ", nu: "ヌ", ne: "ネ", no: "ノ",
  ha: "ハ", hi: "ヒ", hu: "フ", fu: "フ", he: "ヘ", ho: "ホ", ba: "バ", bi: "ビ", bu: "ブ", be: "ベ", bo: "ボ",
  pa: "パ", pi: "ピ", pu: "プ", pe: "ペ", po: "ポ",
  ma: "マ", mi: "ミ", mu: "ム", me: "メ", mo: "モ", ya: "ヤ", yu: "ユ", yo: "ヨ",
  ra: "ラ", ri: "リ", ru: "ル", re: "レ", ro: "ロ", wa: "ワ", wi: "ウィ", we: "ウェ", wo: "ヲ",
  fa: "ファ", fi: "フィ", fe: "フェ", fo: "フォ", va: "ヴァ", vi: "ヴィ", vu: "ヴ", ve: "ヴェ", vo: "ヴォ",
  thi: "ティ", dhi: "ディ", tyi: "ティ", dyi: "ディ", je: "ジェ", che: "チェ", she: "シェ",
};
for (const [head, kana] of Object.entries({ k: "キ", g: "ギ", n: "ニ", h: "ヒ", b: "ビ", p: "ピ", m: "ミ", r: "リ", s: "シ", z: "ジ", t: "チ", d: "ヂ" })) {
  for (const [vowel, small] of [["a", "ャ"], ["u", "ュ"], ["o", "ョ"]]) SYLLABLES[head + "y" + vowel] = kana + small;
}
for (const [head, kana] of [["sh", "シ"], ["ch", "チ"], ["j", "ジ"]]) {
  for (const [vowel, small] of [["a", "ャ"], ["u", "ュ"], ["o", "ョ"]]) SYLLABLES[head + vowel] = kana + small;
}
const LONGEST = Math.max(...Object.keys(SYLLABLES).map((key) => key.length));

function romajiToKana(value) {
  const text = String(value || "").normalize("NFKC").toLowerCase().replace(/[\s'’]+/g, (gap) => gap.includes("'") || gap.includes("’") ? "'" : "");
  if (!/^[a-z'\-]+$/.test(text)) return null;
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "-") { out += "ー"; i++; continue; }
    if (ch === "'") { i++; continue; }
    // 促音：辅音重写（kk、tt、ss……）或者 tch
    if (/[bcdfghjkmpqrstvwxyz]/.test(ch) && (text[i + 1] === ch || (ch === "t" && text[i + 1] === "c"))) { out += "ッ"; i++; continue; }
    if (ch === "n") {
      // nn、n'、词尾的 n、后面跟辅音（y 除外）的 n 都是「ン」
      if (text[i + 1] === "n") { out += "ン"; i += 2; continue; }
      if (i + 1 >= text.length || text[i + 1] === "'" || !/[aiueoy]/.test(text[i + 1])) { out += "ン"; i++; continue; }
    }
    if (ch === "m" && /[bpm]/.test(text[i + 1] || "")) { out += "ン"; i++; continue; }  // 赫本式 shimbun
    let hit = "";
    for (let len = Math.min(LONGEST, text.length - i); len > 0 && !hit; len--) {
      const kana = SYLLABLES[text.slice(i, i + len)];
      if (kana) { hit = kana; i += len; }
    }
    if (!hit) return null;
    out += hit;
  }
  return out;
}

// 查询词换成折叠后的片假名：本来就是假名的直接折叠，整串是罗马音的先转假名。
// 太短的（折叠后不到两个假名）不拿来比，一个假名几乎哪首歌都含。
function queryKana(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text) return "";
  let kana = "";
  if (/^[\p{Script=Hiragana}\p{Script=Katakana}ー\s・]+$/u.test(text)) kana = text.replace(/[\s・]+/g, "");
  else kana = romajiToKana(text) || "";
  const folded = foldKana(kana);
  return [...folded].length >= 2 ? folded : "";
}

module.exports = { foldKana, romajiToKana, queryKana };
