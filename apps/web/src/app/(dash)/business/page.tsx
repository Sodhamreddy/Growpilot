import Link from "next/link";
import { eq, and, desc } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, businessSources, businessLocations } from "@ob/db";
import { BusinessSetup } from "@/components/BusinessSetup";
import { ConfirmProfile } from "@/components/ConfirmProfile";
import { IconCheck, IconAlert, IconClock, IconInbox, IconAudit, IconBusiness, IconLocal } from "@/components/Icons";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

export default async function BusinessPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials = (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
    .slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
  const database = db();
  const business = await getClient();

  if (!business) return <><TopBar section="Workspace" page="Business Intelligence" initials={initials}/><div className="content"><div className="pagehead"><h1>Business Intelligence</h1><p>Tell us about the business so everything we generate is grounded in fact.</p></div><BusinessSetup/></div></>;

  const [facts, locations, sources] = await Promise.all([
    repo.listFacts(database, ctx, business.id),
    database.select().from(businessLocations).where(and(eq(businessLocations.workspaceId, ctx.workspaceId), eq(businessLocations.businessId, business.id))),
    database.select().from(businessSources).where(and(eq(businessSources.workspaceId, ctx.workspaceId), eq(businessSources.businessId, business.id))).orderBy(desc(businessSources.createdAt)),
  ]);
  const source = sources[0];
  const crawling = source?.crawlStatus === "pending" || source?.crawlStatus === "running";
  const broken = source?.crawlStatus === "blocked" || source?.crawlStatus === "failed";
  const verified = facts.filter((f) => f.verified).length;
  const services = facts.filter((f) => f.key === "service");

  return <>
    <TopBar section="Workspace" page="Business Intelligence" initials={initials}/>
    <div className="content intelligence-page">
      <section className="business-identity">
        <span className="business-avatar"><IconBusiness size={24}/></span>
        <div className="business-identity-copy">
          <div className="titlerow"><h1>{business.name}</h1><span className={`badge ${business.confirmedAt ? "ok" : "warn"}`}>{business.confirmedAt ? "Live" : "Needs confirmation"}</span></div>
          <p>{business.websiteUrl ? <a href={business.websiteUrl} target="_blank" rel="noopener noreferrer">{business.websiteUrl.replace(/^https?:\/\//, "")}</a> : "Entered manually"}</p>
          <small>{business.industry ?? "Business"}{business.audience ? ` • ${business.audience}` : ""}</small>
        </div>
        <div className="business-identity-actions"><Link className="btn" href="/settings/business">Edit profile</Link><Link className="btn primary" href="/settings/business">Manage data</Link></div>
      </section>

      <div className="bi-metrics">
        <BiMetric tone="blue" icon={<IconAudit/>} label="Pages discovered" value={source?.pagesDiscovered ?? 0} note={source?.lastCrawledAt ? `Last crawl ${source.lastCrawledAt.toISOString().slice(0,10)}` : "Not crawled yet"}/>
        <BiMetric tone="green" icon={<IconBusiness/>} label="Services found" value={services.length} note="Care services identified"/>
        <BiMetric tone="purple" icon={<IconCheck/>} label="Facts verified" value={`${verified} / ${facts.length}`} note={verified === facts.length && facts.length ? "All facts verified" : "Needs attention"}/>
        <BiMetric tone="orange" icon={<IconLocal/>} label="Locations" value={locations.length} note={locations.length ? "Location data available" : "No locations found"}/>
      </div>

      <nav className="bi-tabs" aria-label="Jump to business intelligence section">
        {source ? <a href="#website-analysis"><IconAudit size={15}/>Website analysis</a> : null}
        <a href="#extracted-facts">Extracted facts</a>
        <a href="#business-locations"><IconLocal size={15}/>Locations</a>
      </nav>

      <div className="bi-workspace"><div className="bi-maincol">
        {source ? <section className="card crawl-card" id="website-analysis">
          <div className="crawl-title"><div><h2>Website Crawl</h2><p>We scan your website to extract services, facts, and important information.</p></div><span className={`badge ${broken ? "fail" : crawling ? "neutral" : "ok"}`}>{source.crawlStatus}</span></div>
          <div className="crawl-status"><span className={`tile-ico ${broken ? "fail" : crawling ? "idle" : "ok"}`}>{broken ? <IconAlert/> : crawling ? <IconClock/> : <IconCheck/>}</span><div><strong>{source.pagesFetched} of {source.pagesDiscovered} discovered pages read</strong><small>{source.lastCrawledAt ? `Last run ${source.lastCrawledAt.toISOString().slice(0,16).replace("T"," ")}` : "Not yet run"}</small></div></div>
          {source.lastError ? <div className="finding error">{source.lastError}</div> : null}
          <div className="crawl-steps">{["Crawling","Extracting","Analyzing","Completed"].map((step,i)=><div className={broken && i>0 ? "" : "done"} key={step}><i>✓</i><strong>{step}</strong><small>{i===0?`${source.pagesFetched} pages`:i===1?"Services & facts":i===2?"Verifying information":"All data processed"}</small></div>)}</div>
        </section> : null}

        <section className="card bi-facts-card" id="extracted-facts">
          <div className="bi-cardhead"><div><h2>Extracted Facts</h2><p>Key information found on your website. Verify facts to improve accuracy.</p></div><span>{facts.length} facts</span></div>
          {facts.length === 0 ? <div className="empty"><span className="empty-ico"><IconInbox/></span><strong>No facts extracted yet</strong><span>{crawling ? "Extraction starts once the crawl finishes." : "Run a crawl to populate this."}</span></div> : <div className="tablewrap"><table><thead><tr><th>Field</th><th>Value &amp; evidence</th><th>Confidence</th><th>Status</th></tr></thead><tbody>{facts.map((f)=>{const pct=Math.round(f.confidence*100);const band=pct>=80?"hi":pct>=50?"mid":"lo";return <tr key={f.id}><td className="muted small">{f.key.replace(/_/g," ")}</td><td><div className="evrow"><strong>{f.value}</strong>{f.sourceQuote?<span className="quote">“{f.sourceQuote}”</span>:null}{f.sourceUrl?<a className="small" href={f.sourceUrl} target="_blank" rel="noopener noreferrer">{f.sourceUrl.replace(/^https?:\/\//,"").slice(0,52)}</a>:null}</div></td><td><div className="conf"><div className="track"><i className={band} style={{width:`${pct}%`}}/></div><span>{pct}%</span></div></td><td><span className={`badge ${f.verified?"ok":pct>=60?"warn":"fail"}`}>{f.verified?"verified":"unverified"}</span></td></tr>})}</tbody></table></div>}
        </section>
        {!business.confirmedAt && facts.length > 0 ? <ConfirmProfile businessId={business.id} factCount={facts.length}/> : null}
      </div><aside className="bi-sidecol">
        <section className="bi-sidecard"><h3>Top Service Categories</h3>{services.length ? services.slice(0,5).map((s)=><div className="service-bar" key={s.id}><span>{s.value}</span><i><b style={{width:`${Math.max(24,Math.round(s.confidence*100))}%`}}/></i><em>{Math.round(s.confidence*100)}</em></div>) : <p>No services extracted yet.</p>}<Link href="/settings/business">View all services →</Link></section>
        <section className="bi-sidecard" id="business-locations"><div className="bi-side-title"><h3>Locations</h3><span>{locations.length} found</span></div>{locations.length ? locations.slice(0,4).map((l)=><div className="location-item" key={l.id}><span><IconLocal size={15}/></span><div><strong>{l.label}</strong><p>{[l.streetAddress,l.locality,l.region,l.postalCode].filter(Boolean).join(", ")||"Address unavailable"}{l.phone?<><br/>{l.phone}</>:null}</p></div></div>) : <p>No locations extracted yet.</p>}<Link href="/settings/business">Manage locations →</Link></section>
      </aside></div>
    </div>
  </>;
}

function BiMetric({tone,icon,label,value,note}:{tone:string;icon:React.ReactNode;label:string;value:number|string;note:string}) {
  return <div className="bi-metric"><span className={`bi-metric-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></div>;
}
