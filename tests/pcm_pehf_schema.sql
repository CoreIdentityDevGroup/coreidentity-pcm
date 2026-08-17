--
-- PostgreSQL database dump
--

\restrict vy922AfS8p2ltulVzE6palDjhh8APFyzAOAUxVTIbrGBwZiAkt0GSCi0xJj8yPp

-- Dumped from database version 15.17
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: pcm_bank_jurisdiction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_bank_jurisdiction AS ENUM (
    'singapore',
    'switzerland',
    'uk',
    'us',
    'other'
);


--
-- Name: pcm_fund_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_fund_status AS ENUM (
    'active',
    'inactive',
    'under_review'
);


--
-- Name: pcm_pehf_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pcm_pehf_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pcm_deal_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_deal_links (
    link_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid NOT NULL,
    pipeline_reference text,
    link_type text NOT NULL,
    link_status text DEFAULT 'active'::text NOT NULL,
    capital_committed_usd numeric(20,2),
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_by text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_deal_links_link_status_check CHECK ((link_status = ANY (ARRAY['active'::text, 'completed'::text, 'withdrawn'::text]))),
    CONSTRAINT pcm_deal_links_link_type_check CHECK ((link_type = ANY (ARRAY['monetization_provider'::text, 'co_investor'::text, 'lender'::text, 'buyer'::text])))
);


--
-- Name: pcm_fund_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_fund_contacts (
    contact_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id uuid NOT NULL,
    full_name text NOT NULL,
    title text,
    email text,
    phone text,
    is_primary boolean DEFAULT false NOT NULL,
    linkedin_url text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_funds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_funds (
    fund_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_name text NOT NULL,
    fund_type text NOT NULL,
    strategy text,
    aum_usd numeric(24,2),
    aum_as_of_date date,
    geography text,
    jurisdiction text,
    regulatory_status text,
    deployment_appetite text,
    min_deal_size_usd numeric(20,2),
    max_deal_size_usd numeric(20,2),
    preferred_asset_types text[],
    status public.pcm_fund_status DEFAULT 'active'::public.pcm_fund_status NOT NULL,
    referral_source text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_funds_fund_type_check CHECK ((fund_type = ANY (ARRAY['private_equity'::text, 'hedge_fund'::text, 'family_office'::text, 'other'::text])))
);


--
-- Name: pcm_schema_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_schema_versions (
    version_id integer NOT NULL,
    schema_name text NOT NULL,
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_by text DEFAULT CURRENT_USER NOT NULL,
    notes text
);


--
-- Name: pcm_schema_versions_version_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pcm_schema_versions_version_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pcm_schema_versions_version_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pcm_schema_versions_version_id_seq OWNED BY public.pcm_schema_versions.version_id;


--
-- Name: pcm_trader_bank_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_trader_bank_relationships (
    rel_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id uuid NOT NULL,
    bank_name text NOT NULL,
    bank_jurisdiction public.pcm_bank_jurisdiction NOT NULL,
    swift_code text,
    branch text,
    relationship_type text NOT NULL,
    account_type text,
    relationship_manager text,
    established_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_trader_bank_relationships_relationship_type_check CHECK ((relationship_type = ANY (ARRAY['primary'::text, 'secondary'::text, 'correspondent'::text])))
);


--
-- Name: pcm_schema_versions version_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions ALTER COLUMN version_id SET DEFAULT nextval('public.pcm_schema_versions_version_id_seq'::regclass);


--
-- Name: pcm_deal_links pcm_deal_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_deal_links
    ADD CONSTRAINT pcm_deal_links_pkey PRIMARY KEY (link_id);


--
-- Name: pcm_fund_contacts pcm_fund_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_fund_contacts
    ADD CONSTRAINT pcm_fund_contacts_pkey PRIMARY KEY (contact_id);


--
-- Name: pcm_funds pcm_funds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_funds
    ADD CONSTRAINT pcm_funds_pkey PRIMARY KEY (fund_id);


--
-- Name: pcm_schema_versions pcm_schema_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions
    ADD CONSTRAINT pcm_schema_versions_pkey PRIMARY KEY (version_id);


--
-- Name: pcm_trader_bank_relationships pcm_trader_bank_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_trader_bank_relationships
    ADD CONSTRAINT pcm_trader_bank_relationships_pkey PRIMARY KEY (rel_id);


--
-- Name: idx_pcm_bank_rels_bank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_bank_rels_bank ON public.pcm_trader_bank_relationships USING btree (bank_name);


--
-- Name: idx_pcm_bank_rels_fund; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_bank_rels_fund ON public.pcm_trader_bank_relationships USING btree (fund_id);


--
-- Name: idx_pcm_deal_links_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_deal_links_asset ON public.pcm_deal_links USING btree (asset_id);


--
-- Name: idx_pcm_deal_links_fund; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_deal_links_fund ON public.pcm_deal_links USING btree (fund_id);


--
-- Name: idx_pcm_deal_links_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_deal_links_status ON public.pcm_deal_links USING btree (link_status);


--
-- Name: idx_pcm_fund_contacts_fund; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_fund_contacts_fund ON public.pcm_fund_contacts USING btree (fund_id);


--
-- Name: idx_pcm_funds_jurisdiction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_funds_jurisdiction ON public.pcm_funds USING btree (jurisdiction);


--
-- Name: idx_pcm_funds_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_funds_status ON public.pcm_funds USING btree (status);


--
-- Name: idx_pcm_funds_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_funds_type ON public.pcm_funds USING btree (fund_type);


--
-- Name: pcm_fund_contacts trg_pcm_fund_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pcm_fund_contacts_updated_at BEFORE UPDATE ON public.pcm_fund_contacts FOR EACH ROW EXECUTE FUNCTION public.pcm_pehf_set_updated_at();


--
-- Name: pcm_funds trg_pcm_funds_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pcm_funds_updated_at BEFORE UPDATE ON public.pcm_funds FOR EACH ROW EXECUTE FUNCTION public.pcm_pehf_set_updated_at();


--
-- Name: pcm_deal_links pcm_deal_links_fund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_deal_links
    ADD CONSTRAINT pcm_deal_links_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES public.pcm_funds(fund_id) ON DELETE RESTRICT;


--
-- Name: pcm_fund_contacts pcm_fund_contacts_fund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_fund_contacts
    ADD CONSTRAINT pcm_fund_contacts_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES public.pcm_funds(fund_id) ON DELETE RESTRICT;


--
-- Name: pcm_trader_bank_relationships pcm_trader_bank_relationships_fund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_trader_bank_relationships
    ADD CONSTRAINT pcm_trader_bank_relationships_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES public.pcm_funds(fund_id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict vy922AfS8p2ltulVzE6palDjhh8APFyzAOAUxVTIbrGBwZiAkt0GSCi0xJj8yPp

