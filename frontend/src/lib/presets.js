/* Presets live on the backend, keyed by a hash of the NovelAI key the request
   carries — so the token is the whole login, and there is nothing else to send. */

const API = import.meta.env?.VITE_API ?? "";

async function req(path, token, init) {
    let r;
    try {
        r = await fetch(`${API}/api/presets${path}`, {
            ...init,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
    } catch {
        throw new Error("Can't reach the server — presets are offline");
    }
    if (!r.ok) {
        const said = await r.json().catch(() => ({}));
        throw new Error(said.detail || `Presets failed (${r.status})`);
    }
    return r.status === 204 ? null : r.json();
}

const seg = (name) => `/${encodeURIComponent(name)}`;

/** [{ name, config, created_at }], newest first. */
export const listPresets = (token) => req("", token);

/** Creates, or overwrites the preset already using that name. */
export const savePreset = (token, name, config) =>
    req(seg(name), token, { method: "PUT", body: JSON.stringify({ config }) });

export const renamePreset = (token, name, to) =>
    req(seg(name), token, { method: "PATCH", body: JSON.stringify({ name: to }) });

export const deletePreset = (token, name) => req(seg(name), token, { method: "DELETE" });
