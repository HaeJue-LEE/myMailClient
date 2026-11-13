import { appHue, appInitial, isAppIcon, type MyApp } from "@/features/apps/apps";

/** The app's picked picture, else its first letter on a colour of its own. */
export function AppTile({ app, className }: { app: Pick<MyApp, "name" | "icon">; className?: string }) {
  const sizing = className ?? "size-6 text-xs";
  // Only pictures the app stored (PNG data URLs) are shown.
  if (app.icon && isAppIcon(app.icon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a local data URL; next/image adds nothing.
      <img
        aria-hidden
        alt=""
        src={app.icon}
        draggable={false}
        className={`shrink-0 rounded-md object-contain ${sizing}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `hsl(${appHue(app.name)} 55% 45%)` }}
      className={`flex shrink-0 items-center justify-center rounded-md font-semibold text-white ${sizing}`}
    >
      {appInitial(app.name)}
    </span>
  );
}
