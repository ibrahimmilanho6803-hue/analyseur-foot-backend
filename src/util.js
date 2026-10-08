"use strict";

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 3) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAccents = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");

// "Atlético  Madrid" -> "atletico madrid" ; "0.5" -> "0 5"
const norm = (s) =>
  stripAccents(s)
    .toLowerCase()
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Retire tout ce qui ressemble à une clé avant d'écrire dans les journaux.
const redact = (s) =>
  String(s)
    .replace(/(\/json\/)[^/?\s]+/g, "$1***")
    .replace(/(key|token|apikey|api_key|x-auth-token)([=:]\s*)[^&\s,"]+/gi, "$1$2***")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");

const DAY_MS = 86400000;

function withTimeout(promise, ms, label = "délai dépassé") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.code = "TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { clamp, round, sleep, stripAccents, norm, redact, withTimeout, DAY_MS };
