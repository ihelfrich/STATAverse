// Shared lab chrome. The lab switcher is one row that scrolls sideways on
// narrow screens; bring the current lab into view without moving the page.
export function initLabChrome() {
  // Shortcut-bar buttons that only move to a part of the page.
  for (const button of document.querySelectorAll(
    ".lab-mobile-nav [data-lab-target]",
  ))
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.labTarget);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    });
  const switcher = document.querySelector(".lab-switcher");
  const current = switcher?.querySelector("[aria-current]");
  if (!current) return;
  const frame = switcher.getBoundingClientRect();
  const link = current.getBoundingClientRect();
  if (link.right <= frame.right) return;
  switcher.scrollLeft += link.left - frame.left - 16;
}
