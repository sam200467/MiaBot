"use strict";
const { normalizeCardNumber, RinnetError, diagnosticText } = require("../rinnet-client.cjs");

// Receives only messages intercepted by the command session, never model input.
async function continueRinnetBinding({ event, text, session, current, end, send, core, config, T, log = () => {} }) {
  if (session.state === "verifying") { await send(event, T.bindBusyVerifying); return true; }
  const client = core.getRinnetClient(config);
  const alive = () => current(event.userId) === session;
  let stage = "input";
  async function finish(account, cardNumber) {
    stage = cardNumber ? "select-card" : "cards-and-profile";
    const binding = await client.bind(account, session.email, cardNumber);
    if (!alive()) return;
    if (binding.cards) {
      session.account = account;
      session.state = "awaitingCard";
      session.attempts = 0;
      await send(event, T.rinnetCardPrompt);
      return;
    }
    stage = "save-binding";
    await core.saveBinding(config, { ...binding, userId: String(event.userId) });
    if (!alive()) return;
    end(event.userId);
    await send(event, T.rinnetSuccess(core.escapeDiscordText(binding.playerName)));
  }
  try {
    if (session.state === "awaitingEmail") {
      const email = String(text).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (++session.attempts >= 3) { end(event.userId); await send(event, T.bindEmailGiveUp); }
        else await send(event, T.bindEmailBad(3 - session.attempts));
        return true;
      }
      session.email = email;
      session.attempts = 0;
      session.state = "awaitingPassword";
      await send(event, T.bindPasswordPrompt);
    } else if (session.state === "awaitingPassword") {
      session.state = "verifying";
      await send(event, T.bindVerifying);
      stage = "login";
      const result = await client.login(session.email, String(text));
      if (!alive()) return true;
      if (result.totpToken) {
        session.totpToken = result.totpToken;
        session.state = "awaitingTotp";
        session.attempts = 0;
        await send(event, T.rinnetTotpPrompt);
      } else await finish(result.account);
    } else if (session.state === "awaitingTotp") {
      const code = String(text).normalize("NFKC").trim();
      if (!/^\d{6}$/.test(code)) {
        if (++session.attempts >= 3) { end(event.userId); await send(event, T.rinnetAttemptsEnd); }
        else await send(event, T.rinnetTotpBad);
        return true;
      }
      session.state = "verifying";
      stage = "totp";
      const account = await client.totp(session.totpToken, code);
      if (!alive()) return true;
      session.totpToken = "";
      await finish(account);
    } else if (session.state === "awaitingCard") {
      const cardNumber = normalizeCardNumber(text);
      if (!cardNumber) {
        if (++session.attempts >= 3) { end(event.userId); await send(event, T.rinnetAttemptsEnd); }
        else await send(event, T.rinnetCardBad);
        return true;
      }
      session.state = "verifying";
      await finish(session.account, cardNumber);
    }
  } catch (error) {
    log("[rinnet-bind-v1] stage=" + stage + " " + diagnosticText(error));
    if (!alive()) return true;
    if (error.code === "TOTP_INVALID" && ++session.attempts < 3) {
      session.state = "awaitingTotp";
      await send(event, T.rinnetTotpBad);
    } else if (error.code === "CARD_NOT_OWNED" && ++session.attempts < 3) {
      session.state = "awaitingCard";
      await send(event, T.rinnetCardNotOwned);
    } else {
      end(event.userId);
      // Only adapter-defined messages are safe to relay; never print arbitrary
      // transport/vault errors containing request objects or tokens.
      await send(event, T.rinnetFailed(error instanceof RinnetError ? core.safeError(error) : "这次没能完成验证，请稍后再试。"));
    }
  }
  return true;
}
module.exports = { continueRinnetBinding };
