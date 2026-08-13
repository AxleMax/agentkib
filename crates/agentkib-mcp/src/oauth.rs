use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agentkib_core::{McpServerConfig, McpServerTransport};
use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use rmcp::transport::{
    AuthClient, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    StoredCredentials,
};

use crate::config;

#[derive(Clone, Default)]
pub struct OAuthManager {
    pending: Arc<Mutex<HashMap<String, PendingAuthorization>>>,
}

struct PendingAuthorization {
    session: AuthorizationSession,
    credential_store: LocalCredentialStore,
}

impl OAuthManager {
    pub async fn start(&self, server: &McpServerConfig, redirect_uri: &str) -> Result<String> {
        let McpServerTransport::StreamableHttp { url } = &server.transport else {
            bail!("OAuth is supported only for Streamable HTTP MCP servers");
        };
        let path = server
            .local_config_path
            .clone()
            .context("MCP local configuration path is unavailable")?;
        let credential_store = LocalCredentialStore {
            path,
            server_id: server.id.clone(),
        };
        ensure_local_server(server, &credential_store.path)?;
        let mut manager = AuthorizationManager::new(url).await?;
        manager.set_credential_store(credential_store.clone());
        let resolution = manager.resolve_metadata().await?;
        manager.set_metadata(resolution.metadata);
        let request = AuthorizationRequest::new(redirect_uri)
            .with_client_name("AgentKib")
            .with_application_type("native");
        let session = AuthorizationSession::new(manager, request)
            .await
            .map_err(|(_, error)| error)?;
        let authorization_url = session.get_authorization_url().to_string();
        self.pending.lock().expect("OAuth pending lock").insert(
            server.id.clone(),
            PendingAuthorization {
                session,
                credential_store,
            },
        );
        Ok(authorization_url)
    }

    pub async fn complete(
        &self,
        server_id: &str,
        code: &str,
        state: &str,
        issuer: Option<&str>,
    ) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .expect("OAuth pending lock")
            .remove(server_id)
            .context("No pending OAuth authorization for this MCP server")?;
        pending
            .session
            .handle_callback_with_issuer(code, state, issuer)
            .await?;
        // Token exchange saves through the credential store. Read it back only to
        // assert persistence succeeded; no token value crosses the IPC boundary.
        pending
            .credential_store
            .load()
            .await?
            .context("OAuth provider did not return credentials")?;
        Ok(())
    }
}

pub async fn authorized_http_client(
    server: &McpServerConfig,
) -> Result<AuthClient<reqwest::Client>> {
    let McpServerTransport::StreamableHttp { url } = &server.transport else {
        bail!("OAuth is supported only for Streamable HTTP MCP servers");
    };
    let store = LocalCredentialStore {
        path: server
            .local_config_path
            .clone()
            .context("MCP local configuration path is unavailable")?,
        server_id: server.id.clone(),
    };
    let mut manager = AuthorizationManager::new(url).await?;
    manager.set_credential_store(store);
    if !manager.initialize_from_store().await? {
        bail!("MCP OAuth authorization is not complete");
    }
    Ok(AuthClient::new(reqwest::Client::new(), manager))
}

fn ensure_local_server(server: &McpServerConfig, path: &std::path::Path) -> Result<()> {
    let mut document = config::read_document(path)?;
    if document.servers.iter().all(|value| value.id != server.id) {
        let mut local = server.clone();
        local.local_config_path = None;
        local.oauth_credentials = None;
        document.servers.push(local);
        config::save_document(path, &document, true)?;
    }
    Ok(())
}

#[derive(Clone)]
struct LocalCredentialStore {
    path: PathBuf,
    server_id: String,
}

#[async_trait]
impl CredentialStore for LocalCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, rmcp::transport::AuthError> {
        let document = config::read_document(&self.path).map_err(auth_store_error)?;
        let Some(value) = document
            .servers
            .into_iter()
            .find(|server| server.id == self.server_id)
            .and_then(|server| server.oauth_credentials)
        else {
            return Ok(None);
        };
        serde_json::from_value(value)
            .map(Some)
            .map_err(auth_store_error)
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), rmcp::transport::AuthError> {
        let mut document = config::read_document(&self.path).map_err(auth_store_error)?;
        let server = document
            .servers
            .iter_mut()
            .find(|server| server.id == self.server_id)
            .ok_or_else(|| auth_store_error("MCP local server entry is missing"))?;
        server.oauth_credentials =
            Some(serde_json::to_value(credentials).map_err(auth_store_error)?);
        config::save_document(&self.path, &document, true).map_err(auth_store_error)
    }

    async fn clear(&self) -> Result<(), rmcp::transport::AuthError> {
        let mut document = config::read_document(&self.path).map_err(auth_store_error)?;
        if let Some(server) = document
            .servers
            .iter_mut()
            .find(|server| server.id == self.server_id)
        {
            server.oauth_credentials = None;
        }
        config::save_document(&self.path, &document, true).map_err(auth_store_error)
    }
}

fn auth_store_error(error: impl std::fmt::Display) -> rmcp::transport::AuthError {
    rmcp::transport::AuthError::InternalError(error.to_string())
}
