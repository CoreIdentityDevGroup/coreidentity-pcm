--
-- PostgreSQL database dump
--

\restrict 9wi2xiaPnDGujqeFyY4aJRSKLAdEIT3ESlJDw8o7DIgihgfulcvS8N5FkzRO6hB

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
-- Name: pcm_agreement_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_agreement_status AS ENUM (
    'draft',
    'pending_signature',
    'partially_signed',
    'fully_executed',
    'expired',
    'superseded',
    'voided'
);


--
-- Name: pcm_agreement_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_agreement_type AS ENUM (
    'payment_guarantee_letter',
    'master_fee_agreement',
    'irrevocable_master_fee_protection_agreement',
    'joint_venture_agreement',
    'joint_venture_partnership_agreement',
    'icc_agreement',
    'non_disclosure_agreement',
    'engagement_letter',
    'letter_of_intent',
    'memorandum_of_understanding',
    'collateral_agreement',
    'monetization_agreement',
    'securitization_agreement',
    'other'
);


--
-- Name: pcm_jurisdiction_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_jurisdiction_type AS ENUM (
    'us',
    'international',
    'both'
);


--
-- Name: pcm_monitoring_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_monitoring_severity AS ENUM (
    'info',
    'warning',
    'critical'
);


--
-- Name: pcm_forms_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pcm_forms_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pcm_agreement_parties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_agreement_parties (
    party_id uuid DEFAULT gen_random_uuid() NOT NULL,
    agreement_id uuid NOT NULL,
    party_name text NOT NULL,
    party_role text NOT NULL,
    party_entity_type text,
    party_jurisdiction text,
    signatory_name text,
    signatory_title text,
    signatory_email text,
    signed boolean DEFAULT false NOT NULL,
    signed_at timestamp with time zone,
    signature_method text,
    signature_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_agreement_type_reference; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_agreement_type_reference (
    ref_id integer NOT NULL,
    agreement_type public.pcm_agreement_type NOT NULL,
    display_name text NOT NULL,
    abbreviation text,
    jurisdiction_type public.pcm_jurisdiction_type NOT NULL,
    pipeline_stage_required text NOT NULL,
    pipeline_gate boolean DEFAULT true NOT NULL,
    typical_parties text[],
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_agreement_type_reference_ref_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pcm_agreement_type_reference_ref_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pcm_agreement_type_reference_ref_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pcm_agreement_type_reference_ref_id_seq OWNED BY public.pcm_agreement_type_reference.ref_id;


--
-- Name: pcm_agreement_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_agreement_versions (
    version_id uuid DEFAULT gen_random_uuid() NOT NULL,
    agreement_id uuid NOT NULL,
    version_number integer NOT NULL,
    gcs_object_path text NOT NULL,
    gcs_bucket text NOT NULL,
    file_name text NOT NULL,
    changed_by text NOT NULL,
    change_reason text,
    change_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_agreements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_agreements (
    agreement_id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid NOT NULL,
    agreement_type public.pcm_agreement_type NOT NULL,
    agreement_type_label text,
    jurisdiction_type public.pcm_jurisdiction_type NOT NULL,
    governing_law text,
    pipeline_stage_required text NOT NULL,
    pipeline_stage_gate boolean DEFAULT true NOT NULL,
    status public.pcm_agreement_status DEFAULT 'draft'::public.pcm_agreement_status NOT NULL,
    effective_date date,
    execution_date date,
    expiry_date date,
    auto_renew boolean DEFAULT false NOT NULL,
    renewal_notice_days integer DEFAULT 30,
    gcs_bucket text NOT NULL,
    gcs_object_path text NOT NULL,
    file_name text NOT NULL,
    content_type text DEFAULT 'application/pdf'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    superseded_by uuid,
    pipeline_reference text NOT NULL,
    monitoring_flag boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_contract_monitoring_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_contract_monitoring_log (
    log_id uuid DEFAULT gen_random_uuid() NOT NULL,
    agreement_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid NOT NULL,
    pipeline_reference text NOT NULL,
    event_type text NOT NULL,
    severity public.pcm_monitoring_severity DEFAULT 'info'::public.pcm_monitoring_severity NOT NULL,
    message text NOT NULL,
    agent_id text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_contract_monitoring_log_event_type_check CHECK ((event_type = ANY (ARRAY['missing_signature'::text, 'missing_required_document'::text, 'approaching_expiry'::text, 'expired'::text, 'pipeline_gate_blocked'::text, 'execution_confirmed'::text, 'renewal_required'::text, 'status_change'::text])))
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
-- Name: pcm_agreement_type_reference ref_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_type_reference ALTER COLUMN ref_id SET DEFAULT nextval('public.pcm_agreement_type_reference_ref_id_seq'::regclass);


--
-- Name: pcm_schema_versions version_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions ALTER COLUMN version_id SET DEFAULT nextval('public.pcm_schema_versions_version_id_seq'::regclass);


--
-- Name: pcm_agreements agreements_gcs_path_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreements
    ADD CONSTRAINT agreements_gcs_path_unique UNIQUE (gcs_bucket, gcs_object_path);


--
-- Name: pcm_agreement_parties pcm_agreement_parties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_parties
    ADD CONSTRAINT pcm_agreement_parties_pkey PRIMARY KEY (party_id);


--
-- Name: pcm_agreement_type_reference pcm_agreement_type_reference_agreement_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_type_reference
    ADD CONSTRAINT pcm_agreement_type_reference_agreement_type_key UNIQUE (agreement_type);


--
-- Name: pcm_agreement_type_reference pcm_agreement_type_reference_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_type_reference
    ADD CONSTRAINT pcm_agreement_type_reference_pkey PRIMARY KEY (ref_id);


--
-- Name: pcm_agreement_versions pcm_agreement_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_versions
    ADD CONSTRAINT pcm_agreement_versions_pkey PRIMARY KEY (version_id);


--
-- Name: pcm_agreements pcm_agreements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreements
    ADD CONSTRAINT pcm_agreements_pkey PRIMARY KEY (agreement_id);


--
-- Name: pcm_contract_monitoring_log pcm_contract_monitoring_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_contract_monitoring_log
    ADD CONSTRAINT pcm_contract_monitoring_log_pkey PRIMARY KEY (log_id);


--
-- Name: pcm_schema_versions pcm_schema_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions
    ADD CONSTRAINT pcm_schema_versions_pkey PRIMARY KEY (version_id);


--
-- Name: pcm_agreement_versions version_agreement_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_versions
    ADD CONSTRAINT version_agreement_unique UNIQUE (agreement_id, version_number);


--
-- Name: idx_pcm_agreements_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_asset ON public.pcm_agreements USING btree (asset_id);


--
-- Name: idx_pcm_agreements_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_client ON public.pcm_agreements USING btree (client_id);


--
-- Name: idx_pcm_agreements_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_expiry ON public.pcm_agreements USING btree (expiry_date) WHERE (expiry_date IS NOT NULL);


--
-- Name: idx_pcm_agreements_monitoring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_monitoring ON public.pcm_agreements USING btree (monitoring_flag) WHERE (monitoring_flag = true);


--
-- Name: idx_pcm_agreements_pipeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_pipeline ON public.pcm_agreements USING btree (pipeline_reference);


--
-- Name: idx_pcm_agreements_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_status ON public.pcm_agreements USING btree (status);


--
-- Name: idx_pcm_agreements_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_agreements_type ON public.pcm_agreements USING btree (agreement_type);


--
-- Name: idx_pcm_monitoring_agreement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_monitoring_agreement ON public.pcm_contract_monitoring_log USING btree (agreement_id);


--
-- Name: idx_pcm_monitoring_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_monitoring_event_type ON public.pcm_contract_monitoring_log USING btree (event_type);


--
-- Name: idx_pcm_monitoring_resolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_monitoring_resolved ON public.pcm_contract_monitoring_log USING btree (resolved) WHERE (resolved = false);


--
-- Name: idx_pcm_monitoring_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_monitoring_severity ON public.pcm_contract_monitoring_log USING btree (severity);


--
-- Name: idx_pcm_parties_agreement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_parties_agreement ON public.pcm_agreement_parties USING btree (agreement_id);


--
-- Name: idx_pcm_parties_signed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_parties_signed ON public.pcm_agreement_parties USING btree (signed);


--
-- Name: idx_pcm_versions_agreement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_versions_agreement ON public.pcm_agreement_versions USING btree (agreement_id);


--
-- Name: pcm_agreements trg_pcm_agreements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pcm_agreements_updated_at BEFORE UPDATE ON public.pcm_agreements FOR EACH ROW EXECUTE FUNCTION public.pcm_forms_set_updated_at();


--
-- Name: pcm_agreement_parties pcm_agreement_parties_agreement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_parties
    ADD CONSTRAINT pcm_agreement_parties_agreement_id_fkey FOREIGN KEY (agreement_id) REFERENCES public.pcm_agreements(agreement_id) ON DELETE RESTRICT;


--
-- Name: pcm_agreement_versions pcm_agreement_versions_agreement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreement_versions
    ADD CONSTRAINT pcm_agreement_versions_agreement_id_fkey FOREIGN KEY (agreement_id) REFERENCES public.pcm_agreements(agreement_id) ON DELETE RESTRICT;


--
-- Name: pcm_agreements pcm_agreements_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agreements
    ADD CONSTRAINT pcm_agreements_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.pcm_agreements(agreement_id);


--
-- Name: pcm_contract_monitoring_log pcm_contract_monitoring_log_agreement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_contract_monitoring_log
    ADD CONSTRAINT pcm_contract_monitoring_log_agreement_id_fkey FOREIGN KEY (agreement_id) REFERENCES public.pcm_agreements(agreement_id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict 9wi2xiaPnDGujqeFyY4aJRSKLAdEIT3ESlJDw8o7DIgihgfulcvS8N5FkzRO6hB

