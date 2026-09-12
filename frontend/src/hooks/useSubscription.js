import { useCallback, useEffect, useState } from "react";
import { REJECTED, verifyToken } from "../lib/nai.js";

export default function useSubscription(token, setToken) {
    const [balance, setBalance] = useState(null);
    const [revision, setRevision] = useState(0);
    const refreshSubscription = useCallback(() => setRevision((n) => n + 1), []);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        let latest = 0;
        let lastCheck = 0;
        async function refresh() {
            const request = ++latest;
            lastCheck = Date.now();
            try {
                const value = await verifyToken(token);
                if (!cancelled && request === latest) setBalance({ token, ...value });
            } catch (e) {
                if (cancelled || request !== latest) return;
                // A failed refresh must not masquerade as a current percentage.
                setBalance((old) => old?.token === token ? { ...old, opus: null } : null);
                // Network failures do not invalidate a saved key.
                if (e.message === REJECTED) setToken("");
            }
        }
        function whenVisible() {
            if (document.visibilityState === "visible" && Date.now() - lastCheck >= 60_000) refresh();
        }
        // NovelAI refreshes shortly after each image to allow usage to settle.
        const initial = setTimeout(refresh, revision ? 500 : 0);
        const interval = setInterval(whenVisible, 60_000);
        document.addEventListener("visibilitychange", whenVisible);
        return () => {
            cancelled = true;
            clearTimeout(initial);
            clearInterval(interval);
            document.removeEventListener("visibilitychange", whenVisible);
        };
    }, [token, setToken, revision]);

    return {
        anlas: token && balance?.token === token ? balance.anlas : null,
        opus: token && balance?.token === token ? balance.opus : null,
        refreshSubscription,
    };
}
