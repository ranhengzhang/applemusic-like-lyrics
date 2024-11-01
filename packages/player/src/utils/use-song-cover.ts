import { useLayoutEffect, useState } from "react";
import type { Song } from "../dexie.ts";

export const useSongCover = (song?: Song) => {
	const [songImgUrl, setSongImgUrl] = useState<string>("");

	useLayoutEffect(() => {
		if (song?.cover) {
			const newUri = URL.createObjectURL(song.cover);
			setSongImgUrl(newUri);
			return () => {
				URL.revokeObjectURL(newUri);
			};
		}
	}, [song?.cover]);

	return songImgUrl;
};
