use std::env;
use std::path::PathBuf;

use agenthub_adapters::{HomeTargets, default_manifest, plan_workspace_changes};
use agenthub_core::{
    AgentKind, load_manifest, resolve_context, scan_workspace, validate_workspace,
};
use anyhow::{Context, Result, bail};

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "scan" => {
            let project = required_path(&args, 1)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&scan_workspace(&project)?)?
            );
        }
        "context" => {
            let project = required_path(&args, 1)?;
            let agent = parse_agent(args.get(2).context("缺少 agent 参数")?)?;
            let cwd = args
                .get(3)
                .map(PathBuf::from)
                .unwrap_or_else(|| project.clone());
            let manifest = load_manifest(&project).ok();
            println!(
                "{}",
                serde_json::to_string_pretty(&resolve_context(
                    &project,
                    &cwd,
                    agent,
                    manifest.as_ref(),
                    Vec::new()
                )?)?
            );
        }
        "plan" => {
            let project = required_path(&args, 1)?;
            let manifest = if agenthub_core::manifest_path(&project).is_file() {
                load_manifest(&project)?
            } else {
                default_manifest(&project)?
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&plan_workspace_changes(
                    &project,
                    &manifest,
                    &HomeTargets::default()
                )?)?
            );
        }
        "validate" => {
            let project = required_path(&args, 1)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&validate_workspace(&project)?)?
            );
        }
        "manifest" => {
            let project = required_path(&args, 1)?;
            println!("{}", serde_yaml::to_string(&default_manifest(&project)?)?);
        }
        _ => print_help(),
    }
    Ok(())
}

fn required_path(args: &[String], index: usize) -> Result<PathBuf> {
    Ok(PathBuf::from(args.get(index).context("缺少项目路径")?))
}
fn parse_agent(value: &str) -> Result<AgentKind> {
    match value {
        "codex" => Ok(AgentKind::Codex),
        "claude" | "claude-code" => Ok(AgentKind::ClaudeCode),
        "openclaw" => Ok(AgentKind::OpenClaw),
        "hermes" => Ok(AgentKind::Hermes),
        _ => bail!("未知 Agent：{value}"),
    }
}
fn print_help() {
    println!(
        "agenthub scan <project>\nagenthub context <project> <codex|claude-code|openclaw|hermes> [cwd]\nagenthub plan <project>\nagenthub validate <project>\nagenthub manifest <project>"
    );
}
