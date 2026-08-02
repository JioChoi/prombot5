import { useEffect, useState } from "react";

/** Live answer to a media query — re-renders when it starts or stops matching,
    which a rotated phone does without ever reloading. */
export default function useMediaQuery(query) {
    const [match, setMatch] = useState(() => window.matchMedia(query).matches);

    useEffect(() => {
        const mq = window.matchMedia(query);
        const on = () => setMatch(mq.matches);
        // Re-read on subscribe: the query can already have flipped between the
        // first render and this effect.
        on();
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, [query]);

    return match;
}
