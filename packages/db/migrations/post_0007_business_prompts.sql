-- Writing instructions move from the workspace to the business.
--
-- An agency runs several clients from one login and they are rarely in the
-- same trade. Held per workspace, a pharmacy's instructions were being applied
-- to a marketing agency's articles, because the boxes belonged to whichever
-- workspace was open rather than to the client on screen.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "prompts" jsonb DEFAULT '{}'::jsonb NOT NULL;
