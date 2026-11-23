import Link from "next/link";
import { eq, and } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, businessLocations, integrations, workspaces, brandVoices } from "@ob/db";
import { TopBar } from "@/components/TopBar";
import { IconBusiness, IconLocal, IconSocial, IconIntegrations, IconSettings, IconVoiceNav, IconArticles, IconCheck, IconArrow } from "@/components/Icons";
import { BrandSection, ServicesSection, LocationsSection, SocialSection, WordPressSection } from "@/components/BusinessInfoForms";
import { PreferencesForm } from "@/components/PreferencesForm";
import { TeamSettings } from "@/components/TeamSettings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials = (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean).slice(0,2).map((p)=>p[0]!.toUpperCase()).join("") || "?";
  const database = db();
  const business = await getClient();
  const [facts, locations, connections, [workspace], voice, draftVoices] = await Promise.all([
    business ? repo.listFacts(database, ctx, business.id) : Promise.resolve([]),
    business ? database.select().from(businessLocations).where(and(eq(businessLocations.workspaceId,ctx.workspaceId),eq(businessLocations.businessId,business.id))) : Promise.resolve([]),
    database.select().from(integrations).where(eq(integrations.workspaceId,ctx.workspaceId)),
    database.select().from(workspaces).where(eq(workspaces.id,ctx.workspaceId)).limit(1),
    business ? repo.getActiveVoice(database,ctx,business.id) : Promise.resolve(null),
    /*
     * Voices that exist but are not active.
     *
     * The card only ever loaded the *active* voice, so it could not tell
     * "nothing has been learned yet" apart from "a profile was learned and is
     * waiting to be switched on" — and said "Brand voice is not configured"
     * for both. Three of four real clients were in the second state, with the
     * card telling them to activate it "from the Brand Voice workspace" and
     * offering no link to one.
     */
    business
      ? database.select({ id: brandVoices.id }).from(brandVoices)
          .where(and(
            eq(brandVoices.workspaceId, ctx.workspaceId),
            eq(brandVoices.businessId, business.id),
            eq(brandVoices.isActive, false),
          )).limit(1)
      : Promise.resolve([]),
  ]);
  const pendingVoice = !voice && draftVoices.length > 0;
  const services = facts.filter((f)=>f.key === "service");
  const wordpress = connections.find((c)=>c.provider === "wordpress" && c.scopeKey === business?.id);
  const prefs = workspace?.settings;
  const canEdit = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";
  const canAdmin = ctx.role === "owner" || ctx.role === "admin";

  return <><TopBar section="Workspace" page="Settings" initials={initials}/><div className="content settings-hub">
    <header className="settings-head"><div><h1>Workspace Settings</h1><p>Manage your business information, integrations, and preferences — everything in one place.</p></div><div className="settings-tip"><IconSettings/><div><strong>Keep your information up to date</strong><small>This helps AI generate accurate content and manage your automations.</small></div></div></header>
    <nav className="settings-tabs">{canAdmin ? <a href="#team">Team</a> : null}<a href="#business" className="active"><IconBusiness size={14}/>Business Info</a><a href="#voice"><IconVoiceNav size={14}/>Brand Voice</a><a href="#services">Services</a><a href="#locations"><IconLocal size={14}/>Locations</a><a href="#social"><IconSocial size={14}/>Social Channels</a><a href="#integrations"><IconIntegrations size={14}/>Integrations</a><a href="#wordpress"><IconArticles size={14}/>WordPress</a><a href="#preferences"><IconSettings size={14}/>Preferences</a></nav>

    <div className="settings-grid">
      {canAdmin ? <SettingsCard id="team" icon={<IconSettings/>} title="Team" subtitle="Members, invites and how articles are approved" action="Manage" editor={<TeamSettings key={ctx.workspaceId}/>}>
        <Status ready={prefs?.reviewProcess === "team"}>{prefs?.reviewProcess === "team" ? "Team review: Content → Manager → Publish" : "One reviewer approves articles"}</Status>
        <p className="settings-copy">Invite teammates, put them on the Content, Manager and Publisher teams, and choose how articles are approved.</p>
      </SettingsCard> : null}
      <SettingsCard id="business" icon={<IconBusiness/>} title="Business Info" subtitle="Your brand details and Google presence" action="Edit" editor={business ? <BrandSection key={business.id} businessId={business.id} canEdit={canEdit} initialLogoUrl={business.logoUrl} initialGmbName={business.gmbName}/> : <p>Add a business before editing its profile.</p>}>
        <div className="settings-fields"><Field label="Business name" value={business?.name ?? "Not configured"}/><Field label="Website URL" value={business?.websiteUrl?.replace(/^https?:\/\//,"") ?? "Not configured"}/><Field label="Industry" value={business?.industry ?? "Not configured"}/><Field label="Target audience" value={business?.audience ?? "Not configured"}/></div>
      </SettingsCard>
      <SettingsCard id="voice" icon={<IconVoiceNav/>} title="Brand Voice" subtitle="How should the AI write for your brand?" action="Details" editor={<div className="inline-info"><strong>{voice ? "Active brand voice" : pendingVoice ? "A profile is waiting to be activated" : "No brand voice yet"}</strong><p>{voice ? "The learned profile is already applied to blogs, social posts, and review replies." : pendingVoice ? "The website crawl learned a voice for this client. Until it is activated, content is written without it and the brand quality gate stays a warning." : "A profile is created automatically once the website crawl finishes."}</p><p style={{marginTop:8}}><Link href="/voice">Open Brand Voice <IconArrow size={13}/></Link></p></div>}>
        <Status ready={Boolean(voice)}>{voice ? "Brand voice learned and active" : pendingVoice ? "Learned, not yet activated" : "Brand voice is not configured"}</Status><p className="settings-copy">Used for blogs, social media, and review replies.</p>
      </SettingsCard>
      <SettingsCard id="services" icon={<IconBusiness/>} title="Services" subtitle="Manage the services you offer" action="Manage" editor={business ? <ServicesSection key={business.id} businessId={business.id} canEdit={canEdit} initial={services.map((s)=>({id:s.id,value:s.value,verified:s.verified,sourceUrl:s.sourceUrl}))}/> : null}>
        <div className="settings-list">{services.slice(0,4).map((s)=><span key={s.id}>{s.value}</span>)}{services.length===0?<em>No services added yet</em>:null}</div><span className="settings-more">Manage all {services.length} services above</span>
      </SettingsCard>
      <SettingsCard id="locations" icon={<IconLocal/>} title="Locations" subtitle="Add and manage your locations" action="Manage" editor={business ? <LocationsSection key={business.id} businessId={business.id} canEdit={canEdit} initial={locations.map((l)=>({id:l.id,label:l.label,streetAddress:l.streetAddress,locality:l.locality,region:l.region,postalCode:l.postalCode,country:l.country,phone:l.phone}))}/> : null}>
        <div className="settings-list">{locations.slice(0,3).map((l)=><span key={l.id}><b>{l.label}</b><small>{[l.locality,l.region].filter(Boolean).join(", ")}</small></span>)}{locations.length===0?<em>No locations added yet</em>:null}</div><span className="settings-more">Manage all {locations.length} locations above</span>
      </SettingsCard>
      <SettingsCard id="social" icon={<IconSocial/>} title="Social Channels" subtitle="Add your social media profiles" action="Manage" editor={business ? <SocialSection key={business.id} businessId={business.id} canEdit={canEdit} initial={business.socialProfiles}/> : null}>
        <ConnectionRows items={["Instagram","Facebook","LinkedIn","X (Twitter)","Pinterest"]} connected={connections.map((c)=>c.provider)}/>
      </SettingsCard>
      <SettingsCard id="wordpress" icon={<IconArticles/>} title="WordPress" subtitle="Connect your site to auto-publish" action="Manage" editor={<WordPressSection key={business?.id ?? "none"} businessId={business?.id ?? ""} canEdit={canAdmin} connected={wordpress ? {displayName:wordpress.displayName,status:wordpress.status} : null}/>}>
        <Status ready={wordpress?.status === "connected"}>{wordpress?.status === "connected" ? (wordpress.displayName ?? "Connected") : "Not connected"}</Status><p className="settings-copy">Approved articles can publish directly to your website.</p>
      </SettingsCard>
      <SettingsCard id="integrations" icon={<IconIntegrations/>} title="Integrations" subtitle="Connection readiness and provider status" action="Details" editor={<div className="inline-info"><strong>Provider credentials required</strong><p>Google, Webflow, and Ghost connections require OAuth or API credentials registered for this deployment. Their live status is shown here; unavailable Connect buttons are intentionally not displayed.</p></div>}>
        <ConnectionRows items={["Google Search Console","Google Analytics 4","Webflow","Ghost"]} connected={connections.map((c)=>c.provider.replace(/_/g," "))}/>
      </SettingsCard>
      <SettingsCard id="preferences" icon={<IconSettings/>} title="Preferences" subtitle="Set how automations behave" action="Edit" editor={<PreferencesForm canEdit={canAdmin} initial={{name:workspace?.name??"",timezone:workspace?.timezone??"UTC",requireApprovalBeforePublish:prefs?.requireApprovalBeforePublish!==false,requireHumanReviewForSensitive:prefs?.requireHumanReviewForSensitive!==false,autoPublishEnabled:prefs?.autoPublishEnabled===true,minSeoScoreToPublish:prefs?.minSeoScoreToPublish??70,minVoiceScoreToPublish:prefs?.minVoiceScoreToPublish??70,aiBudgetUsd:(workspace?.aiBudgetMicros??0)/1_000_000}}/>}>
        <Preference label="Require human approval before publishing" on={prefs?.requireApprovalBeforePublish !== false}/><Preference label="Flag sensitive topics for review" on={prefs?.requireHumanReviewForSensitive !== false}/><Preference label="Allow scheduled auto-publishing" on={prefs?.autoPublishEnabled === true}/><div className="settings-timezone">Timezone <strong>{workspace?.timezone ?? "UTC"}</strong></div>
      </SettingsCard>
    </div>
  </div></>;
}

function SettingsCard({id,icon,title,subtitle,action,editor,children}:{id?:string;icon:React.ReactNode;title:string;subtitle:string;action:string;editor?:React.ReactNode;children:React.ReactNode}){return <section id={id} className="settings-card"><details><summary className="settings-cardhead"><span>{icon}</span><div><h2>{title}</h2><p>{subtitle}</p></div>{editor?<b>{action}</b>:null}</summary>{editor?<div className="settings-inline-editor">{editor}</div>:null}</details><div className="settings-summary">{children}</div></section>}
function Field({label,value}:{label:string;value:string}){return <label><span>{label}</span><b>{value}</b></label>}
function Status({ready,children}:{ready:boolean;children:React.ReactNode}){return <div className={`settings-status ${ready?"ready":""}`}>{ready?<IconCheck size={14}/>:null}<strong>{children}</strong></div>}
function ConnectionRows({items,connected}:{items:string[];connected:string[]}){return <div className="connection-rows">{items.map((item)=>{const live=connected.some((c)=>c.toLowerCase().replace(/_/g," ").includes(item.toLowerCase().split(" ")[0]!));return <span key={item}><b>{item}</b><em className={live?"ready":""}>{live?"Connected":"Not connected"}</em></span>})}</div>}
function Preference({label,on}:{label:string;on:boolean}){return <div className="preference-row"><span>{label}</span><i className={on?"on":""}/></div>}
