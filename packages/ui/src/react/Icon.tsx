import { iconPaths, type IconName } from "../icons";

export default function Icon({
  name,
  size = 20,
}: {
  name: IconName;
  size?: number | string;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}
