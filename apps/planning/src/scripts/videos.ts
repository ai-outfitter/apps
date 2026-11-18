import { onPageLoad } from "@ai-outfitter/ui/page";
import { livePoll } from "@ai-outfitter/ui/live";
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>("[data-video-production]");
  if (!root) return;
  const stamp = root.dataset.stamp;
  livePoll(
    signal,
    async () => {
      const response = await fetch(root.dataset.endpoint!, { signal });
      if (!response.ok) throw Error("Video status unavailable");
      const result = await response.json();
      if (signal.aborted) return;
      const item = (result.data ?? result).videoProductions.items[0];
      const next = JSON.stringify([
        item.revision,
        item.takes.map((t: { id: string; revision: number }) => [
          t.id,
          t.revision,
        ]),
        item.assets.map((a: { id: string }) => a.id),
      ]);
      if (next !== stamp) location.reload();
    },
    {
      every: 10000,
      skip: () =>
        [...document.querySelectorAll("video")].some((video) => !video.paused),
    },
  );
});
