import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { VulnHuntBenchPage } from "./SecurityPage";
import { VulnHuntCredits } from "./parts";

describe("VulnHunt credits", () => {
  it("credits the project and links to its GitHub, safely", () => {
    const { container } = render(<VulnHuntCredits />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/nealbridges/VulnHunter");
    expect(hrefs).toContain("https://github.com/capitalone/VulnHunter");
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(container.textContent).toContain("Apache-2.0");
    expect(container.textContent).toContain("no VulnHunter code is bundled");
  });

  it("is at the bottom of the page even when there is no unit to scan on", () => {
    const { container } = render(<VulnHuntBenchPage spark={null} />);
    expect(container.querySelector(".sec")?.lastElementChild?.tagName).toBe("FOOTER");
  });
});
