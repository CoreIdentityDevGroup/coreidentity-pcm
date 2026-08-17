--
-- PostgreSQL database dump
--

\restrict pdSbQgAnfo1Tx8q7pAnEruloWs6JA7Cu1SQ9F5g1jNh2yATRZ9IPQOlX6OOSmiv

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
-- Name: pcm_asset_pipeline_stage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_asset_pipeline_stage AS ENUM (
    'intake',
    'kyc_verification',
    'appraisal_review',
    'bank_assignment',
    'collateralization',
    'monetization',
    'securitization',
    'tokenization',
    'completed',
    'rejected',
    'on_hold'
);


--
-- Name: pcm_asset_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_asset_type AS ENUM (
    'real_estate',
    'precious_metals',
    'cash_wealth_account',
    'sblc',
    'skr'
);


--
-- Name: pcm_date_validation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_date_validation_status AS ENUM (
    'pending',
    'passed',
    'failed',
    'manual_override'
);


--
-- Name: pcm_asset_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pcm_asset_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pcm_asset_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_asset_documents (
    doc_id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    doc_type text NOT NULL,
    doc_subtype text,
    gcs_bucket text NOT NULL,
    gcs_object_path text NOT NULL,
    file_name text NOT NULL,
    file_size_bytes bigint,
    content_type text,
    submission_date date NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_by text NOT NULL,
    vault_status text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp with time zone,
    deletion_cert_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_asset_documents_vault_status_check CHECK ((vault_status = ANY (ARRAY['active'::text, 'pending_deletion'::text, 'deleted'::text])))
);


--
-- Name: pcm_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_assets (
    asset_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    asset_type public.pcm_asset_type NOT NULL,
    asset_subtype text,
    description text,
    location text,
    declared_value numeric(20,2),
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    pipeline_stage public.pcm_asset_pipeline_stage DEFAULT 'intake'::public.pcm_asset_pipeline_stage NOT NULL,
    pipeline_reference text,
    bank_assignment text,
    bank_assignment_date timestamp with time zone,
    bank_swift_code text,
    token_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    instrument_integrity_status character varying(40) DEFAULT 'pending'::character varying NOT NULL
);


--
-- Name: pcm_bank_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_bank_assignments (
    assignment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid NOT NULL,
    bank_name text NOT NULL,
    bank_jurisdiction text NOT NULL,
    bank_swift_code text,
    assignment_basis text,
    assigned_by text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_classification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_classification_tokens (
    token_id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid NOT NULL,
    asset_type public.pcm_asset_type NOT NULL,
    verified_value numeric(20,2) NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    verification_date date NOT NULL,
    issuing_authority text NOT NULL,
    pipeline_reference text NOT NULL,
    token_purpose text DEFAULT 'identification_and_verification_only'::text NOT NULL,
    transferable boolean DEFAULT false NOT NULL,
    signature_algorithm text DEFAULT 'ML-DSA-65'::text NOT NULL,
    signature text NOT NULL,
    signing_agent_id text NOT NULL,
    minted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT token_non_transferable CHECK ((transferable = false))
);


--
-- Name: pcm_instrument_integrity_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_instrument_integrity_results (
    id integer NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid,
    status character varying(40) NOT NULL,
    fraud_risk_score integer NOT NULL,
    typology_version character varying(20),
    matched_pattern_ids jsonb,
    structural_failures jsonb,
    screened_by_agent character varying(80),
    reviewed_by character varying(120),
    reviewed_at timestamp with time zone,
    verification_channel_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_instrument_integrity_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pcm_instrument_integrity_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pcm_instrument_integrity_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pcm_instrument_integrity_results_id_seq OWNED BY public.pcm_instrument_integrity_results.id;


--
-- Name: pcm_pipeline_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_pipeline_history (
    history_id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    client_id uuid NOT NULL,
    from_stage public.pcm_asset_pipeline_stage,
    to_stage public.pcm_asset_pipeline_stage NOT NULL,
    transitioned_by text NOT NULL,
    transition_role text NOT NULL,
    agent_id text,
    duration_seconds integer,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: pcm_valuations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_valuations (
    valuation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    appraised_value numeric(20,2) NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    appraiser_name text NOT NULL,
    appraiser_organization text,
    appraiser_license text,
    appraisal_date date NOT NULL,
    submission_date date NOT NULL,
    date_validation_status public.pcm_date_validation_status DEFAULT 'pending'::public.pcm_date_validation_status NOT NULL,
    date_validation_agent text,
    date_validation_at timestamp with time zone,
    date_validation_notes text,
    gcs_bucket text NOT NULL,
    gcs_object_path text NOT NULL,
    parsed_value numeric(20,2),
    parsed_at timestamp with time zone,
    parsing_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_instrument_integrity_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_instrument_integrity_results ALTER COLUMN id SET DEFAULT nextval('public.pcm_instrument_integrity_results_id_seq'::regclass);


--
-- Name: pcm_schema_versions version_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions ALTER COLUMN version_id SET DEFAULT nextval('public.pcm_schema_versions_version_id_seq'::regclass);


--
-- Name: pcm_asset_documents pcm_asset_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_asset_documents
    ADD CONSTRAINT pcm_asset_documents_pkey PRIMARY KEY (doc_id);


--
-- Name: pcm_assets pcm_assets_pipeline_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_assets
    ADD CONSTRAINT pcm_assets_pipeline_reference_key UNIQUE (pipeline_reference);


--
-- Name: pcm_assets pcm_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_assets
    ADD CONSTRAINT pcm_assets_pkey PRIMARY KEY (asset_id);


--
-- Name: pcm_bank_assignments pcm_bank_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_bank_assignments
    ADD CONSTRAINT pcm_bank_assignments_pkey PRIMARY KEY (assignment_id);


--
-- Name: pcm_classification_tokens pcm_classification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_classification_tokens
    ADD CONSTRAINT pcm_classification_tokens_pkey PRIMARY KEY (token_id);


--
-- Name: pcm_instrument_integrity_results pcm_instrument_integrity_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_instrument_integrity_results
    ADD CONSTRAINT pcm_instrument_integrity_results_pkey PRIMARY KEY (id);


--
-- Name: pcm_pipeline_history pcm_pipeline_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_pipeline_history
    ADD CONSTRAINT pcm_pipeline_history_pkey PRIMARY KEY (history_id);


--
-- Name: pcm_schema_versions pcm_schema_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions
    ADD CONSTRAINT pcm_schema_versions_pkey PRIMARY KEY (version_id);


--
-- Name: pcm_valuations pcm_valuations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_valuations
    ADD CONSTRAINT pcm_valuations_pkey PRIMARY KEY (valuation_id);


--
-- Name: idx_pcm_asset_docs_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_asset_docs_asset ON public.pcm_asset_documents USING btree (asset_id);


--
-- Name: idx_pcm_assets_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_assets_active ON public.pcm_assets USING btree (asset_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_pcm_assets_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_assets_client ON public.pcm_assets USING btree (client_id);


--
-- Name: idx_pcm_assets_pipeline_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_assets_pipeline_ref ON public.pcm_assets USING btree (pipeline_reference);


--
-- Name: idx_pcm_assets_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_assets_stage ON public.pcm_assets USING btree (pipeline_stage);


--
-- Name: idx_pcm_assets_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_assets_type ON public.pcm_assets USING btree (asset_type);


--
-- Name: idx_pcm_bank_assign_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_bank_assign_asset ON public.pcm_bank_assignments USING btree (asset_id);


--
-- Name: idx_pcm_instrument_integrity_asset_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_instrument_integrity_asset_id ON public.pcm_instrument_integrity_results USING btree (asset_id);


--
-- Name: idx_pcm_pipeline_hist_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_pipeline_hist_asset ON public.pcm_pipeline_history USING btree (asset_id);


--
-- Name: idx_pcm_pipeline_hist_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_pipeline_hist_client ON public.pcm_pipeline_history USING btree (client_id);


--
-- Name: idx_pcm_tokens_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_tokens_asset ON public.pcm_classification_tokens USING btree (asset_id);


--
-- Name: idx_pcm_valuations_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_valuations_asset ON public.pcm_valuations USING btree (asset_id);


--
-- Name: idx_pcm_valuations_date_val; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_valuations_date_val ON public.pcm_valuations USING btree (date_validation_status);


--
-- Name: pcm_assets trg_pcm_assets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pcm_assets_updated_at BEFORE UPDATE ON public.pcm_assets FOR EACH ROW EXECUTE FUNCTION public.pcm_asset_set_updated_at();


--
-- Name: pcm_asset_documents pcm_asset_documents_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_asset_documents
    ADD CONSTRAINT pcm_asset_documents_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.pcm_assets(asset_id) ON DELETE RESTRICT;


--
-- Name: pcm_bank_assignments pcm_bank_assignments_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_bank_assignments
    ADD CONSTRAINT pcm_bank_assignments_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.pcm_assets(asset_id) ON DELETE RESTRICT;


--
-- Name: pcm_classification_tokens pcm_classification_tokens_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_classification_tokens
    ADD CONSTRAINT pcm_classification_tokens_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.pcm_assets(asset_id) ON DELETE RESTRICT;


--
-- Name: pcm_pipeline_history pcm_pipeline_history_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_pipeline_history
    ADD CONSTRAINT pcm_pipeline_history_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.pcm_assets(asset_id) ON DELETE RESTRICT;


--
-- Name: pcm_valuations pcm_valuations_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_valuations
    ADD CONSTRAINT pcm_valuations_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.pcm_assets(asset_id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict pdSbQgAnfo1Tx8q7pAnEruloWs6JA7Cu1SQ9F5g1jNh2yATRZ9IPQOlX6OOSmiv

