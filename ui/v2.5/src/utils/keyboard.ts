export function keyboardClickHandler(onClick: () => void) {
  function onKeyDown(e: React.KeyboardEvent<HTMLAnchorElement>) {
    let { key } = e;
    if (key === " ") key = "Enter";
    if (key === "Enter") {
      onClick();
    }
  }

  return onKeyDown;
}
