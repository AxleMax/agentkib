use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::{ConnectionTransport, Manifest};

pub fn manifest_path(project: &Path) -> PathBuf {
    project.join(".agentkib/manifest.yaml")
}

pub fn load_manifest(project: &Path) -> Result<Manifest> {
    let path = manifest_path(project);
    let content =
        fs::read_to_string(&path).with_context(|| format!("Could not read {}", path.display()))?;
    let manifest: Manifest = serde_yaml::from_str(&content).context("manifest.yaml is invalid")?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.schema_version != 1 {
        bail!("Only schema_version: 1 is supported");
    }
    if manifest.workspace.id.trim().is_empty() || manifest.workspace.name.trim().is_empty() {
        bail!("workspace.id and workspace.name cannot be empty");
    }
    let mut skill_names = BTreeSet::new();
    for skill in &manifest.skills {
        validate_relative_path(&skill.path, "Skill path")?;
        if skill.name.trim().is_empty() {
            bail!("Skill name cannot be empty");
        }
        if !skill_names.insert(skill.name.as_str()) {
            bail!("Duplicate Skill name: {}", skill.name);
        }
    }
    for scoped in &manifest.instructions.scoped {
        validate_relative_path(&scoped.path, "Scoped instruction path")?;
    }
    let mut connection_names = BTreeSet::new();
    for connection in &manifest.connections {
        if connection.name.trim().is_empty() {
            bail!("MCP connection name cannot be empty");
        }
        if !connection_names.insert(connection.name.as_str()) {
            bail!("Duplicate MCP connection name: {}", connection.name);
        }
        for (name, value) in &connection.env {
            if !value.starts_with("${") || !value.ends_with('}') {
                bail!(
                    "Environment variable {} for connection {} must use a ${{VAR}} reference",
                    name,
                    connection.name
                );
            }
        }
        match &connection.transport {
            ConnectionTransport::Stdio { command, .. } if command.trim().is_empty() => {
                bail!("stdio command cannot be empty")
            }
            ConnectionTransport::Http { url }
                if !(url.starts_with("http://") || url.starts_with("https://")) =>
            {
                bail!("HTTP MCP URL is invalid")
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_relative_path(value: &str, label: &str) -> Result<()> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        bail!("{label} must be a relative path inside the project: {value}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterState, InstructionSet, MemoryPolicy, SkillDefinition, WorkspaceIdentity};
    use std::collections::BTreeMap;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: 1,
            workspace: WorkspaceIdentity {
                id: "p1".into(),
                name: "demo".into(),
            },
            instructions: InstructionSet::default(),
            skills: vec![],
            connections: vec![],
            memories: MemoryPolicy::default(),
            adapters: BTreeMap::<_, AdapterState>::new(),
        }
    }

    #[test]
    fn rejects_paths_outside_project() {
        let mut value = manifest();
        value.skills.push(SkillDefinition {
            name: "unsafe".into(),
            path: "../secret/SKILL.md".into(),
            targets: vec![],
        });
        assert!(validate_manifest(&value).is_err());
    }
}
