#!/usr/bin/env tsx

/**
 * Investigation script: List all Linear teams and projects
 * Usage: node --env-file=.env --import=tsx scripts/investigate-linear.ts
 */

import { LinearClient } from '@linear/sdk';

async function main() {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;

  if (!apiKey) {
    console.error('ERROR: LINEAR_API_KEY not found in environment');
    process.exit(1);
  }

  const client = new LinearClient({ apiKey });

  console.log('='.repeat(80));
  console.log('LINEAR TEAMS');
  console.log('='.repeat(80));

  const teams = await client.teams();

  for (const team of teams.nodes) {
    console.log(`\nTeam: ${team.name}`);
    console.log(`  ID: ${team.id}`);
    console.log(`  Key: ${team.key}`);
    console.log(`  Description: ${team.description || '(none)'}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('LINEAR PROJECTS');
  console.log('='.repeat(80));

  const projects = await client.projects();

  for (const project of projects.nodes) {
    // Fetch team info for each project
    const projectTeams = await project.teams();
    const teamNames = projectTeams.nodes.map(t => t.name).join(', ');

    console.log(`\nProject: ${project.name}`);
    console.log(`  ID: ${project.id}`);
    console.log(`  State: ${project.state}`);
    console.log(`  Teams: ${teamNames || '(none)'}`);
    console.log(`  Description: ${project.description || '(none)'}`);
    console.log(`  Icon: ${project.icon || '(none)'}`);
    console.log(`  Color: ${project.color || '(none)'}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total teams: ${teams.nodes.length}`);
  console.log(`Total projects: ${projects.nodes.length}`);
  console.log(`\nConfigured TEAM_ID: ${teamId || '(not set)'}`);

  // Check if any project belongs to the configured team
  if (teamId) {
    console.log('\nProjects belonging to configured team:');
    for (const project of projects.nodes) {
      const projectTeams = await project.teams();
      const belongsToTeam = projectTeams.nodes.some(t => t.id === teamId);
      if (belongsToTeam) {
        console.log(`  ✓ ${project.name} (${project.id})`);
      }
    }
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
