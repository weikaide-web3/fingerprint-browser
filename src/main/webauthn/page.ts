/**
 * 在页面上下文里执行的 WebAuthn 脚本。
 *
 * 用字符串而不是闭包：闭包会被 Playwright 序列化，容易踩到作用域与转义问题；
 * 字符串脚本只接收 base64 参数，边界清晰，也便于单测直接检查源码。
 * 刻意不使用模板字符串与反引号，避免与 TS 的 template literal 冲突。
 */

const HELPERS = [
  'function __dec(b64){var s=atob(b64);var u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}',
  'function __enc(buf){var u=(buf instanceof Uint8Array)?buf:new Uint8Array(buf);var s="";for(var j=0;j<u.length;j++)s+=String.fromCharCode(u[j]);return btoa(s);}'
].join('\n')

/** 注册：navigator.credentials.create，回传 credentialId 与 attestationObject */
export const PAGE_CREATE = `async function (a) {
${HELPERS}
  try {
    var cred = await navigator.credentials.create({ publicKey: {
      challenge: __dec(a.challengeB64),
      rp: { id: a.rpId, name: a.rpName || a.rpId },
      user: { id: __dec(a.userB64), name: a.userName || (a.rpId + '-user'), displayName: a.userName || 'user' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 30000,
      attestation: 'none'
    } });
    if (!cred) return { error: '内核未返回凭证' };
    var resp = cred.response;
    return {
      credentialIdB64: __enc(cred.rawId),
      attestationB64: __enc(resp.attestationObject),
      clientDataB64: __enc(resp.clientDataJSON),
      transports: resp.getTransports ? Array.prototype.slice.call(resp.getTransports()) : [],
      attachment: cred.authenticatorAttachment || null
    };
  } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
}`

/** 登录：navigator.credentials.get，回传断言（签名 + authData） */
export const PAGE_GET = `async function (a) {
${HELPERS}
  try {
    var assertion = await navigator.credentials.get({ publicKey: {
      challenge: __dec(a.challengeB64),
      allowCredentials: [{ type: 'public-key', id: __dec(a.allowB64) }],
      userVerification: 'required',
      timeout: 30000
    } });
    if (!assertion) return { error: '内核未返回断言' };
    var r = assertion.response;
    return {
      signatureB64: __enc(r.signature),
      authDataB64: __enc(r.authenticatorData),
      userHandleB64: r.userHandle ? __enc(r.userHandle) : null,
      matches: __enc(assertion.rawId) === a.allowB64
    };
  } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
}`

/** 探测：站点能否看到 passkey 能力（isConditionalMediationAvailable 等） */
export const PAGE_PROBE = `async function () {
  var out = {
    hasCredentials: typeof navigator.credentials !== 'undefined',
    hasCreate: !!(navigator.credentials && navigator.credentials.create),
    hasGet: !!(navigator.credentials && navigator.credentials.get),
    isSecureContext: window.isSecureContext,
    conditionalMediation: null,
    authenticatorAttachment: null
  };
  try { out.conditionalMediation = await navigator.credentials.isConditionalMediationAvailable(); } catch (e) { out.conditionalMediation = null; }
  try {
    var rnd = new Uint8Array(32); crypto.getRandomValues(rnd);
    var c = await navigator.credentials.create({ publicKey: {
      challenge: rnd,
      rp: { id: location.hostname, name: location.hostname },
      user: { id: rnd, name: 'probe@' + location.hostname, displayName: 'probe' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 8000, attestation: 'none'
    } });
    if (c) { out.authenticatorAttachment = c.authenticatorAttachment || null; out.probeCredentialId = c.id; }
  } catch (e) { out.probeError = String(e && e.message ? e.message : e); }
  return out;
}`