import { useEffect, useState } from "react";

const PREFIX = "prombot:";

/**
 * useState that mirrors to localStorage on every change and rehydrates on load.
 * Reads/writes are guarded: private-mode Safari and full quotas both throw, and
 * a settings field is not worth taking the app down for.
 */
export default function usePersistentState(key, initial) {
    const [value, setValue] = useState(() => {
        try {
            const raw = localStorage.getItem(PREFIX + key);
            return raw === null ? initial : JSON.parse(raw);
        } catch {
            return initial;
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch {
            /* storage unavailable — settings just don't persist this session */
        }
    }, [key, value]);

    return [value, setValue];
}
