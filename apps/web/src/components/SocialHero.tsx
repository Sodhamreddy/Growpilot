/**
 * The Social Media Timeline header, shared by the topic pool and the calendar.
 *
 * Both are views of one tool, so they keep one header and switch beneath it.
 * A different header on each would read as two products.
 */
export function SocialHero() {
  return (
    <div className="social-hero">
      <div className="social-hero-copy">
      <span className="social-eyebrow">Social media automation</span>
      <h1>Social Media Timeline</h1>
      <p>
        A pool of ready-to-use content ideas written for your audience. Plan, customize,
        and schedule your posts across all platforms — in just a few clicks.
      </p>
      <div className="social-networks" aria-label="Supported social platforms">
        <span><b className="net instagram">◎</b>Instagram</span>
        <span><b className="net facebook">f</b>Facebook</span>
        <span><b className="net linkedin">in</b>LinkedIn</span>
        <span><b className="net xnet">𝕏</b>X (Twitter)</span>
        <span><b className="net pinterest">p</b>Pinterest</span>
      </div>
      </div>
      <div className="social-hero-art" aria-hidden="true">
        <span className="hero-note">Plan smarter<br/>Post consistently<br/>Grow faster</span>
        <span className="hero-calendar">♥</span>
        <span className="hero-card">Great care creates<br/>stronger communities.</span>
      </div>
    </div>
  );
}
