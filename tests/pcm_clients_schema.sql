--
-- PostgreSQL database dump
--

\restrict WdMORGDnmyBNJDE6w3lgfbDfo9w2itr7ZE1CFzTA3QdLglZ2al4CEKSVTmNKrq6

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
-- Name: pcm_ofac_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_ofac_status AS ENUM (
    'pending',
    'clear',
    'flagged',
    'manual_review',
    'not_authoritatively_screened',
    'attested_out_of_band'
);


--
-- Name: pcm_pipeline_stage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_pipeline_stage AS ENUM (
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
-- Name: pcm_user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_user_role AS ENUM (
    'trade_group_owner',
    'program_manager',
    'intake_officer',
    'system'
);


--
-- Name: pcm_vault_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pcm_vault_status AS ENUM (
    'active',
    'pending_deletion',
    'deleted'
);


--
-- Name: pcm_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pcm_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pcm_agent_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_agent_activity (
    activity_id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_name text NOT NULL,
    agent_id text,
    client_id uuid,
    asset_id uuid,
    action text,
    status text,
    decision text,
    proof_pack_id text,
    duration_ms integer,
    result_summary jsonb,
    triggered_by text DEFAULT 'auto'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_asset_backings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_asset_backings (
    backing_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pcm_asset_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_asset_types (
    asset_type_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    requires_description boolean DEFAULT false,
    active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pcm_banks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_banks (
    bank_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pcm_client_auth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_client_auth (
    auth_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_login timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_client_id_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_client_id_documents (
    id_doc_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    doc_type text NOT NULL,
    id_number text NOT NULL,
    issuing_country text NOT NULL,
    expiry_date date,
    gcs_bucket text,
    gcs_object_path text,
    file_name text,
    content_type text,
    vault_status public.pcm_vault_status DEFAULT 'active'::public.pcm_vault_status NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_by text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_client_pipeline_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_client_pipeline_audit (
    audit_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    from_stage public.pcm_pipeline_stage,
    to_stage public.pcm_pipeline_stage NOT NULL,
    transitioned_by text NOT NULL,
    transition_role public.pcm_user_role NOT NULL,
    agent_id text,
    reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_clients (
    client_id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    phone text,
    country_of_origin text NOT NULL,
    jurisdiction text,
    referral_source text,
    referral_contact text,
    pipeline_stage public.pcm_pipeline_stage DEFAULT 'intake'::public.pcm_pipeline_stage NOT NULL,
    assigned_trade_group_owner text,
    assigned_program_manager text,
    assigned_intake_officer text,
    bank_assignment text,
    bank_assignment_date timestamp with time zone,
    bank_assignment_by text,
    ofac_status public.pcm_ofac_status DEFAULT 'pending'::public.pcm_ofac_status NOT NULL,
    ofac_screened_at timestamp with time zone,
    ofac_provider text,
    ofac_reference_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    given_name text,
    family_name text,
    date_of_birth date
);


--
-- Name: pcm_deletion_certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_deletion_certificates (
    cert_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    asset_id uuid,
    scope text NOT NULL,
    deleted_object_count integer NOT NULL,
    deleted_object_paths text[] DEFAULT '{}'::text[] NOT NULL,
    deletion_timestamp timestamp with time zone DEFAULT now() NOT NULL,
    algorithm text DEFAULT 'ML-DSA-65'::text NOT NULL,
    certificate_hash text NOT NULL,
    certificate_signature text NOT NULL,
    signing_agent_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_documents (
    document_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    transaction_id uuid,
    document_type character varying(100),
    file_name character varying(500) NOT NULL,
    file_size_bytes integer,
    mime_type character varying(100),
    storage_path text NOT NULL,
    uploaded_by uuid,
    version integer DEFAULT 1,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pcm_kyc_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_kyc_documents (
    doc_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
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
    vault_status public.pcm_vault_status DEFAULT 'active'::public.pcm_vault_status NOT NULL,
    deleted_at timestamp with time zone,
    deletion_cert_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_leads (
    lead_id uuid DEFAULT gen_random_uuid() NOT NULL,
    submitted_by text NOT NULL,
    client_name text NOT NULL,
    contact_info text,
    service_type text,
    referral_type text,
    referrer_id uuid,
    status text DEFAULT 'new'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_leads_status_check CHECK ((status = ANY (ARRAY['new'::text, 'qualified'::text, 'in_progress'::text, 'closed'::text, 'rejected'::text])))
);


--
-- Name: pcm_monitoring_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_monitoring_runs (
    idempotency_key text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    results jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT pcm_monitoring_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))
);


--
-- Name: pcm_ofac_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_ofac_results (
    result_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    provider text NOT NULL,
    provider_reference_id text,
    status public.pcm_ofac_status NOT NULL,
    match_count integer DEFAULT 0 NOT NULL,
    raw_response_summary text,
    screened_by_agent text,
    screened_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    review_outcome text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    list_version_id uuid,
    match_method text,
    match_score numeric,
    compared_fields jsonb,
    CONSTRAINT pcm_ofac_results_match_method_check CHECK (((match_method IS NULL) OR (match_method = ANY (ARRAY['exact'::text, 'near_exact'::text, 'fuzzy'::text]))))
);


--
-- Name: pcm_password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_password_reset_tokens (
    token_id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    initiated_by text
);


--
-- Name: pcm_pipeline_stage_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_pipeline_stage_definitions (
    stage_def_id uuid DEFAULT gen_random_uuid() NOT NULL,
    stage_number integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    active boolean DEFAULT true
);


--
-- Name: pcm_pof_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_pof_records (
    pof_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    declared_amount numeric(20,2) NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    issuing_bank text NOT NULL,
    issuing_bank_swift text,
    account_reference text,
    gcs_bucket text NOT NULL,
    gcs_object_path text NOT NULL,
    submission_date date NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    verified_by text,
    verification_notes text,
    vault_status public.pcm_vault_status DEFAULT 'active'::public.pcm_vault_status NOT NULL,
    deleted_at timestamp with time zone,
    deletion_cert_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_referral_commissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_referral_commissions (
    commission_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    referrer_id uuid,
    referral_type text NOT NULL,
    referral_contact text,
    amount numeric(15,2),
    currency text DEFAULT 'USD'::text,
    payment_status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_referral_commissions_payment_status_check CHECK ((payment_status = ANY (ARRAY['pending'::text, 'approved'::text, 'paid'::text, 'cancelled'::text])))
);


--
-- Name: pcm_referrers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_referrers (
    referrer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    referral_type text NOT NULL,
    contact_name text NOT NULL,
    company text,
    email text,
    phone text,
    notes text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_rules_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_rules_content (
    rule_id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_type character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    content text NOT NULL,
    version integer DEFAULT 1,
    active boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pcm_rules_content_rule_type_check CHECK (((rule_type)::text = ANY (ARRAY[('kyc_instructions'::character varying)::text, ('pof_instructions'::character varying)::text, ('rules_of_the_road'::character varying)::text])))
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
-- Name: pcm_sdn_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_sdn_aliases (
    alias_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entry_id uuid NOT NULL,
    version_id uuid NOT NULL,
    alias_type text,
    category text,
    first_name text,
    last_name text NOT NULL,
    name_normalized text NOT NULL,
    name_canonical text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_sdn_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_sdn_entries (
    entry_id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    sdn_uid integer NOT NULL,
    sdn_type text NOT NULL,
    first_name text,
    last_name text NOT NULL,
    program_list jsonb,
    dob_list jsonb,
    id_list jsonb,
    address_list jsonb,
    name_normalized text NOT NULL,
    name_canonical text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcm_sdn_list_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_sdn_list_versions (
    version_id uuid DEFAULT gen_random_uuid() NOT NULL,
    publish_date date,
    record_count integer,
    retrieved_at timestamp with time zone DEFAULT now() NOT NULL,
    fetch_status text DEFAULT 'success'::text NOT NULL,
    fetch_error text,
    source_url text NOT NULL,
    file_sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_sdn_list_versions_fetch_status_check CHECK ((fetch_status = ANY (ARRAY['success'::text, 'failed'::text]))),
    CONSTRAINT publish_date_required_on_success CHECK (((fetch_status = 'failed'::text) OR (publish_date IS NOT NULL)))
);


--
-- Name: pcm_securities_instruments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_securities_instruments (
    instrument_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    requires_description boolean DEFAULT false,
    active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pcm_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_staff (
    staff_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    password_hash text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_login timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pcm_staff_role_check CHECK ((role = ANY (ARRAY['trade_group_owner'::text, 'program_manager'::text, 'intake_officer'::text])))
);


--
-- Name: pcm_transaction_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_transaction_stages (
    stage_id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    stage_number integer NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    notes text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pcm_transaction_stages_stage_number_check CHECK (((stage_number >= 1) AND (stage_number <= 8))),
    CONSTRAINT pcm_transaction_stages_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('in_progress'::character varying)::text, ('completed'::character varying)::text, ('skipped'::character varying)::text, ('not_applicable'::character varying)::text])))
);


--
-- Name: pcm_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcm_transactions (
    transaction_id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    transaction_type character varying(50) NOT NULL,
    crypto_wallet_address text,
    crypto_wallet_link text,
    asset_type_id uuid,
    asset_description text,
    asset_backing_id uuid,
    instrument_id uuid,
    instrument_description text,
    bank_id uuid,
    asset_jurisdiction text,
    asset_location text,
    owner_name text,
    beneficiary_same_as_owner boolean DEFAULT true,
    beneficiary_name text,
    been_in_trade_before boolean DEFAULT false,
    rules_acknowledged boolean DEFAULT false,
    rules_acknowledged_at timestamp with time zone,
    status character varying(50) DEFAULT 'active'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pcm_transactions_transaction_type_check CHECK (((transaction_type)::text = ANY (ARRAY[('crypto'::character varying)::text, ('cash'::character varying)::text, ('asset'::character varying)::text])))
);


--
-- Name: pcm_schema_versions version_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions ALTER COLUMN version_id SET DEFAULT nextval('public.pcm_schema_versions_version_id_seq'::regclass);


--
-- Name: pcm_client_id_documents id_doc_gcs_path_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_id_documents
    ADD CONSTRAINT id_doc_gcs_path_unique UNIQUE (gcs_bucket, gcs_object_path);


--
-- Name: pcm_kyc_documents kyc_gcs_path_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_kyc_documents
    ADD CONSTRAINT kyc_gcs_path_unique UNIQUE (gcs_bucket, gcs_object_path);


--
-- Name: pcm_agent_activity pcm_agent_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agent_activity
    ADD CONSTRAINT pcm_agent_activity_pkey PRIMARY KEY (activity_id);


--
-- Name: pcm_asset_backings pcm_asset_backings_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_asset_backings
    ADD CONSTRAINT pcm_asset_backings_name_key UNIQUE (name);


--
-- Name: pcm_asset_backings pcm_asset_backings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_asset_backings
    ADD CONSTRAINT pcm_asset_backings_pkey PRIMARY KEY (backing_id);


--
-- Name: pcm_asset_types pcm_asset_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_asset_types
    ADD CONSTRAINT pcm_asset_types_name_key UNIQUE (name);


--
-- Name: pcm_asset_types pcm_asset_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_asset_types
    ADD CONSTRAINT pcm_asset_types_pkey PRIMARY KEY (asset_type_id);


--
-- Name: pcm_banks pcm_banks_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_banks
    ADD CONSTRAINT pcm_banks_name_key UNIQUE (name);


--
-- Name: pcm_banks pcm_banks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_banks
    ADD CONSTRAINT pcm_banks_pkey PRIMARY KEY (bank_id);


--
-- Name: pcm_client_auth pcm_client_auth_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_auth
    ADD CONSTRAINT pcm_client_auth_email_key UNIQUE (email);


--
-- Name: pcm_client_auth pcm_client_auth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_auth
    ADD CONSTRAINT pcm_client_auth_pkey PRIMARY KEY (auth_id);


--
-- Name: pcm_client_id_documents pcm_client_id_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_id_documents
    ADD CONSTRAINT pcm_client_id_documents_pkey PRIMARY KEY (id_doc_id);


--
-- Name: pcm_client_pipeline_audit pcm_client_pipeline_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_pipeline_audit
    ADD CONSTRAINT pcm_client_pipeline_audit_pkey PRIMARY KEY (audit_id);


--
-- Name: pcm_clients pcm_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_clients
    ADD CONSTRAINT pcm_clients_pkey PRIMARY KEY (client_id);


--
-- Name: pcm_deletion_certificates pcm_deletion_certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_deletion_certificates
    ADD CONSTRAINT pcm_deletion_certificates_pkey PRIMARY KEY (cert_id);


--
-- Name: pcm_documents pcm_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_documents
    ADD CONSTRAINT pcm_documents_pkey PRIMARY KEY (document_id);


--
-- Name: pcm_kyc_documents pcm_kyc_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_kyc_documents
    ADD CONSTRAINT pcm_kyc_documents_pkey PRIMARY KEY (doc_id);


--
-- Name: pcm_leads pcm_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_leads
    ADD CONSTRAINT pcm_leads_pkey PRIMARY KEY (lead_id);


--
-- Name: pcm_monitoring_runs pcm_monitoring_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_monitoring_runs
    ADD CONSTRAINT pcm_monitoring_runs_pkey PRIMARY KEY (idempotency_key);


--
-- Name: pcm_ofac_results pcm_ofac_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_ofac_results
    ADD CONSTRAINT pcm_ofac_results_pkey PRIMARY KEY (result_id);


--
-- Name: pcm_password_reset_tokens pcm_password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_password_reset_tokens
    ADD CONSTRAINT pcm_password_reset_tokens_pkey PRIMARY KEY (token_id);


--
-- Name: pcm_pipeline_stage_definitions pcm_pipeline_stage_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_pipeline_stage_definitions
    ADD CONSTRAINT pcm_pipeline_stage_definitions_pkey PRIMARY KEY (stage_def_id);


--
-- Name: pcm_pipeline_stage_definitions pcm_pipeline_stage_definitions_stage_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_pipeline_stage_definitions
    ADD CONSTRAINT pcm_pipeline_stage_definitions_stage_number_key UNIQUE (stage_number);


--
-- Name: pcm_pof_records pcm_pof_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_pof_records
    ADD CONSTRAINT pcm_pof_records_pkey PRIMARY KEY (pof_id);


--
-- Name: pcm_referral_commissions pcm_referral_commissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_referral_commissions
    ADD CONSTRAINT pcm_referral_commissions_pkey PRIMARY KEY (commission_id);


--
-- Name: pcm_referrers pcm_referrers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_referrers
    ADD CONSTRAINT pcm_referrers_pkey PRIMARY KEY (referrer_id);


--
-- Name: pcm_rules_content pcm_rules_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_rules_content
    ADD CONSTRAINT pcm_rules_content_pkey PRIMARY KEY (rule_id);


--
-- Name: pcm_rules_content pcm_rules_content_rule_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_rules_content
    ADD CONSTRAINT pcm_rules_content_rule_type_key UNIQUE (rule_type);


--
-- Name: pcm_schema_versions pcm_schema_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_schema_versions
    ADD CONSTRAINT pcm_schema_versions_pkey PRIMARY KEY (version_id);


--
-- Name: pcm_sdn_aliases pcm_sdn_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_sdn_aliases
    ADD CONSTRAINT pcm_sdn_aliases_pkey PRIMARY KEY (alias_id);


--
-- Name: pcm_sdn_entries pcm_sdn_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_sdn_entries
    ADD CONSTRAINT pcm_sdn_entries_pkey PRIMARY KEY (entry_id);


--
-- Name: pcm_sdn_list_versions pcm_sdn_list_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_sdn_list_versions
    ADD CONSTRAINT pcm_sdn_list_versions_pkey PRIMARY KEY (version_id);


--
-- Name: pcm_securities_instruments pcm_securities_instruments_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_securities_instruments
    ADD CONSTRAINT pcm_securities_instruments_name_key UNIQUE (name);


--
-- Name: pcm_securities_instruments pcm_securities_instruments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_securities_instruments
    ADD CONSTRAINT pcm_securities_instruments_pkey PRIMARY KEY (instrument_id);


--
-- Name: pcm_staff pcm_staff_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_staff
    ADD CONSTRAINT pcm_staff_email_key UNIQUE (email);


--
-- Name: pcm_staff pcm_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_staff
    ADD CONSTRAINT pcm_staff_pkey PRIMARY KEY (staff_id);


--
-- Name: pcm_transaction_stages pcm_transaction_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transaction_stages
    ADD CONSTRAINT pcm_transaction_stages_pkey PRIMARY KEY (stage_id);


--
-- Name: pcm_transaction_stages pcm_transaction_stages_transaction_id_stage_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transaction_stages
    ADD CONSTRAINT pcm_transaction_stages_transaction_id_stage_number_key UNIQUE (transaction_id, stage_number);


--
-- Name: pcm_transactions pcm_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transactions
    ADD CONSTRAINT pcm_transactions_pkey PRIMARY KEY (transaction_id);


--
-- Name: idx_agent_activity_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_activity_agent ON public.pcm_agent_activity USING btree (agent_name);


--
-- Name: idx_agent_activity_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_activity_asset ON public.pcm_agent_activity USING btree (asset_id);


--
-- Name: idx_agent_activity_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_activity_client ON public.pcm_agent_activity USING btree (client_id);


--
-- Name: idx_agent_activity_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_activity_created ON public.pcm_agent_activity USING btree (created_at DESC);


--
-- Name: idx_pcm_audit_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_audit_client ON public.pcm_client_pipeline_audit USING btree (client_id);


--
-- Name: idx_pcm_client_auth_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_client_auth_email ON public.pcm_client_auth USING btree (email) WHERE (active = true);


--
-- Name: idx_pcm_client_id_docs_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_client_id_docs_client ON public.pcm_client_id_documents USING btree (client_id);


--
-- Name: idx_pcm_client_id_docs_vault_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_client_id_docs_vault_status ON public.pcm_client_id_documents USING btree (vault_status);


--
-- Name: idx_pcm_clients_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_clients_country ON public.pcm_clients USING btree (country_of_origin);


--
-- Name: idx_pcm_clients_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_clients_email ON public.pcm_clients USING btree (email) WHERE (deleted_at IS NULL);


--
-- Name: idx_pcm_clients_ofac_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_clients_ofac_status ON public.pcm_clients USING btree (ofac_status);


--
-- Name: idx_pcm_clients_pipeline_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_clients_pipeline_stage ON public.pcm_clients USING btree (pipeline_stage) WHERE (deleted_at IS NULL);


--
-- Name: idx_pcm_deletion_certs_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_deletion_certs_client ON public.pcm_deletion_certificates USING btree (client_id);


--
-- Name: idx_pcm_documents_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_documents_client ON public.pcm_documents USING btree (client_id);


--
-- Name: idx_pcm_documents_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_documents_transaction ON public.pcm_documents USING btree (transaction_id);


--
-- Name: idx_pcm_kyc_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_kyc_client ON public.pcm_kyc_documents USING btree (client_id);


--
-- Name: idx_pcm_kyc_vault_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_kyc_vault_status ON public.pcm_kyc_documents USING btree (vault_status);


--
-- Name: idx_pcm_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_leads_status ON public.pcm_leads USING btree (status);


--
-- Name: idx_pcm_leads_submitted_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_leads_submitted_by ON public.pcm_leads USING btree (submitted_by);


--
-- Name: idx_pcm_monitoring_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_monitoring_runs_started ON public.pcm_monitoring_runs USING btree (started_at DESC);


--
-- Name: idx_pcm_ofac_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_ofac_client ON public.pcm_ofac_results USING btree (client_id);


--
-- Name: idx_pcm_ofac_results_list_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_ofac_results_list_version ON public.pcm_ofac_results USING btree (list_version_id);


--
-- Name: idx_pcm_password_reset_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pcm_password_reset_tokens_hash ON public.pcm_password_reset_tokens USING btree (token_hash);


--
-- Name: idx_pcm_password_reset_tokens_staff_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_password_reset_tokens_staff_active ON public.pcm_password_reset_tokens USING btree (staff_id) WHERE (used_at IS NULL);


--
-- Name: idx_pcm_pof_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_pof_client ON public.pcm_pof_records USING btree (client_id);


--
-- Name: idx_pcm_referrers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_referrers_type ON public.pcm_referrers USING btree (referral_type) WHERE (active = true);


--
-- Name: idx_pcm_sdn_aliases_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_aliases_canonical ON public.pcm_sdn_aliases USING btree (version_id, name_canonical);


--
-- Name: idx_pcm_sdn_aliases_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_aliases_entry ON public.pcm_sdn_aliases USING btree (entry_id);


--
-- Name: idx_pcm_sdn_aliases_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_aliases_normalized ON public.pcm_sdn_aliases USING btree (version_id, name_normalized);


--
-- Name: idx_pcm_sdn_aliases_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_aliases_version ON public.pcm_sdn_aliases USING btree (version_id);


--
-- Name: idx_pcm_sdn_entries_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_entries_canonical ON public.pcm_sdn_entries USING btree (version_id, name_canonical);


--
-- Name: idx_pcm_sdn_entries_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_entries_normalized ON public.pcm_sdn_entries USING btree (version_id, name_normalized);


--
-- Name: idx_pcm_sdn_entries_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_entries_uid ON public.pcm_sdn_entries USING btree (version_id, sdn_uid);


--
-- Name: idx_pcm_sdn_entries_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_entries_version ON public.pcm_sdn_entries USING btree (version_id);


--
-- Name: idx_pcm_sdn_versions_publish_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_versions_publish_date ON public.pcm_sdn_list_versions USING btree (publish_date DESC);


--
-- Name: idx_pcm_sdn_versions_retrieved_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_sdn_versions_retrieved_at ON public.pcm_sdn_list_versions USING btree (retrieved_at DESC);


--
-- Name: idx_pcm_staff_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_staff_email ON public.pcm_staff USING btree (email) WHERE (active = true);


--
-- Name: idx_pcm_transaction_stages_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_transaction_stages_transaction ON public.pcm_transaction_stages USING btree (transaction_id);


--
-- Name: idx_pcm_transactions_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcm_transactions_client ON public.pcm_transactions USING btree (client_id);


--
-- Name: pcm_clients trg_pcm_clients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pcm_clients_updated_at BEFORE UPDATE ON public.pcm_clients FOR EACH ROW EXECUTE FUNCTION public.pcm_set_updated_at();


--
-- Name: pcm_agent_activity pcm_agent_activity_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_agent_activity
    ADD CONSTRAINT pcm_agent_activity_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE SET NULL;


--
-- Name: pcm_client_auth pcm_client_auth_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_auth
    ADD CONSTRAINT pcm_client_auth_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id);


--
-- Name: pcm_client_id_documents pcm_client_id_documents_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_id_documents
    ADD CONSTRAINT pcm_client_id_documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE RESTRICT;


--
-- Name: pcm_client_pipeline_audit pcm_client_pipeline_audit_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_client_pipeline_audit
    ADD CONSTRAINT pcm_client_pipeline_audit_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE RESTRICT;


--
-- Name: pcm_deletion_certificates pcm_deletion_certificates_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_deletion_certificates
    ADD CONSTRAINT pcm_deletion_certificates_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE RESTRICT;


--
-- Name: pcm_documents pcm_documents_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_documents
    ADD CONSTRAINT pcm_documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id);


--
-- Name: pcm_documents pcm_documents_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_documents
    ADD CONSTRAINT pcm_documents_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.pcm_transactions(transaction_id);


--
-- Name: pcm_kyc_documents pcm_kyc_documents_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_kyc_documents
    ADD CONSTRAINT pcm_kyc_documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE RESTRICT;


--
-- Name: pcm_leads pcm_leads_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_leads
    ADD CONSTRAINT pcm_leads_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.pcm_referrers(referrer_id);


--
-- Name: pcm_ofac_results pcm_ofac_results_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_ofac_results
    ADD CONSTRAINT pcm_ofac_results_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE RESTRICT;


--
-- Name: pcm_ofac_results pcm_ofac_results_list_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_ofac_results
    ADD CONSTRAINT pcm_ofac_results_list_version_id_fkey FOREIGN KEY (list_version_id) REFERENCES public.pcm_sdn_list_versions(version_id);


--
-- Name: pcm_password_reset_tokens pcm_password_reset_tokens_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_password_reset_tokens
    ADD CONSTRAINT pcm_password_reset_tokens_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.pcm_staff(staff_id) ON DELETE CASCADE;


--
-- Name: pcm_pof_records pcm_pof_records_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_pof_records
    ADD CONSTRAINT pcm_pof_records_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id) ON DELETE RESTRICT;


--
-- Name: pcm_referral_commissions pcm_referral_commissions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_referral_commissions
    ADD CONSTRAINT pcm_referral_commissions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id);


--
-- Name: pcm_referral_commissions pcm_referral_commissions_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_referral_commissions
    ADD CONSTRAINT pcm_referral_commissions_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.pcm_referrers(referrer_id);


--
-- Name: pcm_sdn_aliases pcm_sdn_aliases_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_sdn_aliases
    ADD CONSTRAINT pcm_sdn_aliases_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.pcm_sdn_entries(entry_id) ON DELETE CASCADE;


--
-- Name: pcm_sdn_aliases pcm_sdn_aliases_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_sdn_aliases
    ADD CONSTRAINT pcm_sdn_aliases_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.pcm_sdn_list_versions(version_id) ON DELETE CASCADE;


--
-- Name: pcm_sdn_entries pcm_sdn_entries_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_sdn_entries
    ADD CONSTRAINT pcm_sdn_entries_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.pcm_sdn_list_versions(version_id) ON DELETE CASCADE;


--
-- Name: pcm_transaction_stages pcm_transaction_stages_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transaction_stages
    ADD CONSTRAINT pcm_transaction_stages_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.pcm_transactions(transaction_id);


--
-- Name: pcm_transactions pcm_transactions_asset_backing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transactions
    ADD CONSTRAINT pcm_transactions_asset_backing_id_fkey FOREIGN KEY (asset_backing_id) REFERENCES public.pcm_asset_backings(backing_id);


--
-- Name: pcm_transactions pcm_transactions_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transactions
    ADD CONSTRAINT pcm_transactions_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.pcm_asset_types(asset_type_id);


--
-- Name: pcm_transactions pcm_transactions_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transactions
    ADD CONSTRAINT pcm_transactions_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.pcm_banks(bank_id);


--
-- Name: pcm_transactions pcm_transactions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transactions
    ADD CONSTRAINT pcm_transactions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.pcm_clients(client_id);


--
-- Name: pcm_transactions pcm_transactions_instrument_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcm_transactions
    ADD CONSTRAINT pcm_transactions_instrument_id_fkey FOREIGN KEY (instrument_id) REFERENCES public.pcm_securities_instruments(instrument_id);


--
-- PostgreSQL database dump complete
--

\unrestrict WdMORGDnmyBNJDE6w3lgfbDfo9w2itr7ZE1CFzTA3QdLglZ2al4CEKSVTmNKrq6

