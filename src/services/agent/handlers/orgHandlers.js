/**
 * @file orgHandlers.js
 * @description Handlers for organization management tools
 */

const crypto = require('crypto');
const db = require('../../../db/knex');
const { isOrgHead, findUserInOrg } = require('../resolvers');
const { setPendingAction } = require('../confirmation');
const { buildOrganizationOverview } = require('../contextBuilders');

async function handleListCollaborators(args, { user, org }) {
  const members = await db('organization_members')
    .join('users', 'organization_members.user_id', 'users.id')
    .where('organization_members.org_id', org.id)
    .select('users.id', 'users.name', 'users.email', 'users.role', 'organization_members.joined_at');

  return {
    organization: org.name,
    count: members.length,
    is_user_head: isOrgHead(user, org),
    members: members.map((m) => ({
      name: m.name,
      email: m.email,
      role: m.role || 'collaborator',
      is_owner: m.id === org.owner_id,
      joined_at: m.joined_at,
    })),
  };
}

async function handleUpdateOrganization(args, { user, org, skipConfirmation }) {
  if (!isOrgHead(user, org)) {
    return { error: '⛔ Only the Organization Owner or Organizer can rename the organization.' };
  }

  const newName = (args.name || '').trim();
  if (!newName) return { error: 'Organization name cannot be empty.' };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'update_organization', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm organization update:**\n• Current Name: **${org.name}**\n• New Name: **${newName}**\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  const [updated] = await db('organizations')
    .where({ id: org.id })
    .update({ name: newName })
    .returning('*');

  return {
    success: true,
    message: `✅ Organization successfully renamed to **${updated.name}**!`,
    organization: updated,
  };
}

async function handleCreateOrgInviteLink(args, { user, org }) {
  if (!isOrgHead(user, org)) {
    return { error: '⛔ Only the Organization Owner or Organizer can generate organization invite links.' };
  }

  const inviteCode = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [invite] = await db('org_invite_links')
    .insert({
      org_id: org.id,
      invite_code: inviteCode,
      created_by: user.id,
      expires_at: expiresAt,
      is_active: true,
    })
    .returning('*');

  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
  const inviteUrl = `${baseUrl}/join/${invite.invite_code}`;

  return {
    success: true,
    message: `🏢 **Organization Invite Link Created:**\n${inviteUrl}\n\n*Valid for 7 days.*`,
    invite_url: inviteUrl,
    invite_code: invite.invite_code,
    organization_name: org.name,
  };
}

async function handleRevokeOrgInviteLink(args, { user, org }) {
  if (!isOrgHead(user, org)) {
    return { error: '⛔ Only the Organization Owner or Organizer can revoke invite links.' };
  }

  if (args.invite_code) {
    await db('org_invite_links')
      .where({ org_id: org.id, invite_code: args.invite_code })
      .update({ is_active: false });
  } else {
    await db('org_invite_links')
      .where({ org_id: org.id, is_active: true })
      .update({ is_active: false });
  }

  return {
    success: true,
    message: `✅ Organization invite link(s) revoked successfully.`,
  };
}

async function handleRemoveOrgMember(args, { user, org, skipConfirmation }) {
  if (!isOrgHead(user, org)) {
    return { error: '⛔ Only the Organization Owner or Organizer can remove members from the organization.' };
  }

  const target = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!target) {
    return { error: `Member "${args.collaborator_name_or_email}" not found in organization.` };
  }

  if (target.id === org.owner_id) {
    return { error: '⛔ Cannot remove the organization owner.' };
  }

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'remove_organization_member', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm removing member:**\n• Organization: **${org.name}**\n• Member: **${target.name}** (${target.email})\n\nReply **"YES"** to remove or **"NO"** to cancel.`,
    };
  }

  await db('organization_members').where({ org_id: org.id, user_id: target.id }).del();

  return {
    success: true,
    message: `✅ **${target.name}** has been removed from **"${org.name}"**.`,
  };
}

async function handleGetOrgOverview(args, { user, org }) {
  return await buildOrganizationOverview(org, user);
}

module.exports = {
  list_collaborators: handleListCollaborators,
  update_organization: handleUpdateOrganization,
  create_organization_invite_link: handleCreateOrgInviteLink,
  revoke_organization_invite_link: handleRevokeOrgInviteLink,
  remove_organization_member: handleRemoveOrgMember,
  get_organization_overview: handleGetOrgOverview,
};
